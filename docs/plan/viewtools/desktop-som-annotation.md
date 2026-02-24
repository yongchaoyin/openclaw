# 桌面截图 Set-of-Marks (SoM) 标注方案

## Context

桌面模式鼠标反复无法精确选中目标。根本原因：通用 VLM 天生不擅长估计像素坐标。

虽然已实现 accessibility ref 系统（`[ref=d1]` 出现在文本树中），但 VLM 仍然倾向于"猜坐标"而非使用 ref，因为**截图中看不到任何视觉标记**来对应 ref 编号。

浏览器模式成功的关键是 **Set-of-Marks**：在截图上叠加橙色边框 + ref 编号标签（`pw-tools-core.interactions.ts:479-604`），VLM 可以直接"看到"每个 ref 对应哪个元素，从而准确选择。

**目标**：在桌面截图上也叠加同样风格的标注，让 VLM 能通过视觉匹配 ref，而非猜坐标。

## 坐标关系分析

经过 auto-resize 修复后的坐标链：

```
screencapture → 3840×2160 (物理像素)
sips -Z 1920  → 1920×1080 (逻辑像素) = 发给 VLM 的图像
AX tree bounds → (x, y, w, h) 也是逻辑像素
∴ bounds 坐标直接等于图像像素坐标，无需 scaleFactor 转换
```

如果用户设了 `maxWidth=800`（进一步缩小），需要缩放：

```
overlayX = axBounds.x × (imageWidth / screenWidth)
         = 500 × (800 / 1920) = 208.3
```

## 实现方案

### 核心：使用 Sharp SVG composite 在截图上绘制标注

与浏览器模式的 DOM CSS 注入不同，桌面模式无法注入到屏幕上。改用 **Sharp 的 SVG composite** 在截图图像上绘制标注框和编号标签。

标注样式完全复用浏览器模式（`#ffb020` 橙色边框 + 标签），视觉一致。

### 修改文件清单

| 文件                                       | 改动                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| `src/agents/tools/visual-tool.observe.ts`  | 在 `observeDesktop` 中调用标注函数，返回带标注的截图 |
| `src/agents/tools/visual-tool.loop.ts`     | 微调提示词，强调"截图中的橙色标注框对应 ref"         |
| `src/agents/tools/visual-tool.annotate.ts` | **新文件**：Sharp SVG composite 标注实现             |

### 1. 新建 `visual-tool.annotate.ts`

```typescript
// 约 80 行
import type { DesktopAxRef } from "../../node-host/invoke-desktop.js";

/**
 * 在桌面截图上绘制 Set-of-Marks 标注（橙色边框 + ref 编号标签）。
 * 使用 Sharp SVG composite，风格与浏览器模式一致。
 */
export async function annotateDesktopScreenshot(params: {
  imageBase64: string;
  mimeType: string;
  axRefs: DesktopAxRef[];
  /** 截图像素宽 (resize 后) */
  imageWidth: number;
  imageHeight: number;
  /** 屏幕逻辑宽 */
  screenWidth: number;
  screenHeight: number;
}): Promise<{ base64: string; mimeType: string }> {
  if (!params.axRefs.length) {
    return { base64: params.imageBase64, mimeType: params.mimeType };
  }

  // 复用 loadSharp (src/media/image-ops.ts 已有)
  const mod = (await import("sharp")) as any;
  const sharp = mod.default ?? mod;

  const scaleX = params.imageWidth / params.screenWidth;
  const scaleY = params.imageHeight / params.screenHeight;

  const svgParts: string[] = [];
  for (const ref of params.axRefs) {
    const x = Math.round(ref.bounds.x * scaleX);
    const y = Math.round(ref.bounds.y * scaleY);
    const w = Math.round(ref.bounds.w * scaleX);
    const h = Math.round(ref.bounds.h * scaleY);
    if (w < 4 || h < 4) continue; // 太小的元素跳过

    const tagW = ref.ref.length * 8 + 8;
    const tagH = 16;
    const tagY = Math.max(0, y - tagH - 2);

    // 橙色边框
    svgParts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ffb020" stroke-width="2"/>`,
    );
    // ref 标签背景
    svgParts.push(
      `<rect x="${x}" y="${tagY}" width="${tagW}" height="${tagH}" fill="#ffb020" rx="3"/>`,
    );
    // ref 文本
    svgParts.push(
      `<text x="${x + 4}" y="${tagY + 12}" font-family="monospace" font-size="12" fill="#1a1a1a">${ref.ref}</text>`,
    );
  }

  const svgOverlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${params.imageWidth}" height="${params.imageHeight}">${svgParts.join("")}</svg>`,
  );

  const inputBuffer = Buffer.from(params.imageBase64, "base64");
  const annotated = await sharp(inputBuffer, { failOnError: false })
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .png()
    .toBuffer();

  return { base64: annotated.toString("base64"), mimeType: "image/png" };
}
```

### 2. 修改 `visual-tool.observe.ts`

在 `observeDesktop` 函数末尾，获取到 `image` 和 `axRefs` 后，调用 `annotateDesktopScreenshot` 标注截图：

```typescript
import { annotateDesktopScreenshot } from "./visual-tool.annotate.js";

// ... 在 return 之前 ...
// 如果有 axRefs 且有图像尺寸信息，在截图上绘制 SoM 标注
let annotatedImage = image;
if (axRefs && axRefs.length > 0 && screenWidth && screenHeight && imageWidth && imageHeight) {
  try {
    annotatedImage = await annotateDesktopScreenshot({
      imageBase64: image.base64,
      mimeType: image.mimeType,
      axRefs: axRefs as DesktopAxRef[],
      imageWidth, imageHeight,
      screenWidth, screenHeight,
    });
  } catch {
    // 标注失败不阻塞，使用原始截图
  }
}

return {
  capturedAt: params.now(),
  target: "desktop",
  image: annotatedImage,  // 使用标注后的截图
  ...
};
```

关键：需要从 `details` 中提取 `width`/`height`（图像像素），从 `screenWidth`/`screenHeight`（屏幕逻辑像素）来计算缩放比。

### 3. 修改 `visual-tool.loop.ts` 提示词

```typescript
if (snapshotText) {
  desktopRules.push(
    "A UI element tree from the accessibility API is provided below.",
    "Each actionable element has a [ref=dN] tag. The screenshot has ORANGE labeled boxes matching these refs.",
    'ALWAYS use ref to interact: {"kind":"click","ref":"d5","reason":"click the button"}',
    "The runtime will click the exact center of the ref element — no coordinate guessing needed.",
    "Only estimate x/y from the screenshot when NO matching ref exists in the tree.",
  );
}
```

### 4. 导出 `DesktopAxRef` 类型

`invoke-desktop.ts` 中的 `DesktopAxRef` 类型需要 export（当前已 export），确保 `visual-tool.annotate.ts` 能导入。

## 不需要修改的文件

- `invoke-desktop.ts` — 已完成 ref 索引 + axRefs 返回（前一轮改动）
- `visual-tool.execute.ts` — ref → 精确坐标的执行路径已完成
- `visual-tool.parse.ts` — coordSpace 解析已完成
- `nodes-tool.ts` / `nodes-desktop.ts` — screenWidth/screenHeight 传递已完成

## 验证方式

1. `pnpm build` — 类型检查通过
2. `pnpm test -- --run src/agents/tools/visual-tool` — 现有测试不回归
3. 手动验证标注效果：
   - 截一张桌面截图，用 Sharp 叠加 SVG，检查标注框位置和样式
   - 在 Retina Mac 上用 visual 工具执行简单桌面任务，验证 VLM 是否正确使用 ref
4. 对比改进前后在 3 个典型任务上的首次成功率和总重试次数
