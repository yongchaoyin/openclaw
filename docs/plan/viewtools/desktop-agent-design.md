# 桌面自动化能力增强设计方案

## 1. 目标

让 OpenClaw 具备**像人一样操作电脑**的能力：用户通过任意已接入渠道（飞书、Telegram、WhatsApp、Web 等）发送自然语言指令（如"打开系统设置"、"帮我截个图发到微信"），Agent 自动调用 visual-tool 执行桌面操作并通过同一渠道反馈结果。

不新建独立入口。复用现有 gateway → 渠道 → agent → 工具体系，增量增强 visual-tool 的桌面操作能力。

## 2. 现有能力基线

基于对代码库的完整审查，以下能力已经实现且可直接复用：

### 2.1 视觉循环引擎（已完成）

`src/agents/tools/visual-tool.ts`（1700+ 行）：

- 完整的 截图 → VLM 决策 → 执行动作 → 循环 流程
- 四种操作模式：`run`（自动循环）、`step`（单步）、`stop`（中止）、`status`（查询）
- 上下文窗口：最近 N 张截图滑动送入模型（默认 5，范围 1-10）
- 三层重试：模型调用（5 次）、截图获取（5 次）、动作执行（1 次）
- Trace 记录：每轮完整追踪（时间、截图元数据、VLM 决策、执行结果）
- 配置系统：全局 + agent 级别合并，所有参数可覆盖
- 自动节点选择：`ensureDesktopNode` 自动发现并选择桌面能力节点（新增功能）

### 2.2 桌面操作后端（已完成，macOS）

`src/node-host/invoke-desktop.ts`：

- 截图：macOS 原生 `/usr/sbin/screencapture`，支持 PNG/JPEG、多显示器/单显示器、尺寸调整
- 键鼠控制：JXA (JavaScript for Automation) + CGEvent API
- 支持动作：click/doubleClick/rightClick/move/drag/type/hotkey/scroll/wait
- Unicode 文本输入、组合快捷键、动画拖拽
- 无第三方依赖，纯 macOS 系统工具

### 2.3 VLM 模型集成（已完成）

- 支持 OpenAI (gpt-5-mini)、Anthropic (claude-opus-4-6)、MiniMax (MiniMax-VL-01) 等
- 模型回退链：primary → fallbacks 自动尝试
- 桌面模式提示词已区分坐标系统（`x/y` for desktop, `ref` for browser）

### 2.4 浏览器自动化（已完成）

- Playwright 驱动，支持 snapshot（带标注截图）、act、navigate
- refs 模式定位元素，天然适配视觉定位
- sandbox/host/node 三种运行模式

### 2.5 安全治理（已完成）

- 动作白名单：硬编码 11 种允许的动作
- 高风险动作审批：`requireApprovalActions` 配置
- 截图上传策略：`screenshotUploadPolicy` 控制
- 节点命令策略：allowlist/denylist + 审批链路

### 2.6 渠道体系（已完成）

- 10+ 内置渠道 + 扩展插件（飞书、Telegram、WhatsApp、Discord、Slack、Signal、iMessage、Web 等）
- 统一的消息收发接口
- 支持图片/文件发送（可用于回传截图）

## 3. 差距分析

### G1：桌面截图缺少结构化文本信息（P0）

**现状**：`observeDesktop` 返回的 `snapshotText` 是空字符串。VLM 在桌面模式下只能看图片，没有结构化文本辅助定位。而 browser 模式有完整的 DOM snapshot 文本（包含元素类型、文本内容、ref 标识）。

**影响**：VLM 纯靠图片输出 x,y 坐标，精度依赖模型视觉能力，容易点错位置。

**方案**：

方案 A — macOS Accessibility API（推荐）：

- 通过 JXA 调用 `AXUIElement` API 获取当前窗口的 UI 元素树
- 提取元素类型（button/textfield/menu 等）、文本内容、位置坐标（bounds）
- 生成类似 browser snapshot 的结构化文本，送入 VLM 提示词
- 优势：精确的元素位置和类型信息，无需额外依赖
- 限制：需要 macOS 辅助功能权限；不同 app 的 accessibility 支持程度不一

方案 B — Vision OCR：

- 通过 macOS Vision 框架（`VNRecognizeTextRequest`）对截图做 OCR
- 提取屏幕上可见文本及其位置
- 优势：不依赖 app 的 accessibility 实现
- 限制：只能获取文本，无法识别 UI 控件类型；中文 OCR 精度需验证

**建议**：两者结合。以 Accessibility API 为主获取 UI 元素树，以 OCR 为补充处理 Accessibility 不可用的场景（如游戏、远程桌面、自绘 UI）。

**实施位置**：

- `src/node-host/invoke-desktop.ts` — 新增 `desktop.accessibility_snapshot` 命令
- `src/agents/tools/visual-tool.ts` 的 `observeDesktop` — 调用新命令并填充 `snapshotText`

### G2：VLM 提示词坐标精度不足（P0）

**现状**：桌面模式的提示词（`buildVisualModelPrompt`）仅告知 VLM "Desktop actions rely on screen coordinates"，缺少：

- 截图实际分辨率（VLM 需要知道图片尺寸才能输出正确坐标）
- 屏幕缩放比例（Retina 显示器 2x 缩放会导致坐标偏移）
- 坐标校准指导（点击失败后如何调整）
- G1 获取的 UI 元素信息的参考格式

**方案**：

增强桌面模式提示词，加入：

```
Screen resolution: {width}x{height} (scale factor: {scaleFactor})
The image dimensions match the logical screen coordinates.
Use the UI elements list below to identify targets precisely.
If a previous click missed, adjust coordinates based on the element bounds.

UI Elements (from accessibility):
[0] Button "系统设置" at (120, 45, 80, 24)
[1] TextField "搜索" at (200, 45, 150, 24)
...

When an element is listed, prefer using its center coordinates.
When no matching element exists, estimate from the screenshot.
```

**实施位置**：

- `src/agents/tools/visual-tool.ts` 的 `buildVisualModelPrompt` — 桌面分支增强
- `src/node-host/invoke-desktop.ts` — `desktop.snapshot` 返回分辨率和缩放信息

### G3：操作过程反馈（P1）

**现状**：visual-tool 执行过程中用户无感知。循环完成后才返回结果。对于耗时较长的桌面任务（10-50 轮循环），用户不知道 Agent 在做什么。

**方案**：

通过现有消息渠道回传关键节点信息：

1. **任务开始**：发送"开始执行桌面任务：{goal}"
2. **关键动作**：每执行一个有意义的动作，发送简短描述（如"点击了'系统设置'按钮"）
3. **任务完成**：发送最终截图 + 结果摘要
4. **任务失败**：发送错误信息 + 最后一张截图

实现方式：

- 在 `runVisualLoop` 中增加 `onProgress` 回调
- 回调通过 agent 的消息发送能力将进度推送到用户所在渠道
- 频率控制：不是每轮都发，而是在关键节点发（开始、类型变化的动作、完成、失败）
- 截图发送：仅在完成/失败时发送截图（避免流量过大）

**实施位置**：

- `src/agents/tools/visual-tool.ts` — `runVisualLoop` 增加回调机制
- 回调接入点由调用方（agent）提供，visual-tool 本身不直接依赖渠道

### G4：任务规划能力（P1）

**现状**：visual-tool 是单步循环 — 每轮只决策一个动作。对于复杂任务（"帮我发一封邮件给张三，内容是..."），VLM 需要自行维护长期目标，容易在中间步骤迷失。

**方案**：

这个问题不需要在 visual-tool 层面解决。OpenClaw 的 Agent 本身就是一个规划器：

- Agent 收到用户消息"帮我发一封邮件"
- Agent 自行分解为子步骤（打开邮件客户端、新建邮件、填写收件人...）
- 对每个子步骤调用 visual-tool 的 `run` 或 `step`
- 如果某个子步骤失败，Agent 可以换策略重试

需要增强的是 Agent 使用 visual-tool 的指导（system prompt / tool description）：

- 更新 visual-tool 的 `description` 字段，说明何时使用 `run` vs `step`
- 建议 Agent 对复杂任务使用 `step` 模式逐步执行，保持控制
- 在 Agent 的 system prompt 中增加桌面操作指导（如何描述 goal、何时切换策略）

**实施位置**：

- `src/agents/tools/visual-tool.ts` — 优化 `description` 和 `parameters` 描述
- Agent system prompt 配置 — 增加桌面操作使用指导

### G5：代码质量（P2）

**现状**：`visual-tool.ts` 1700+ 行，超出项目指南（500-700 LOC）2.4 倍。

**方案**：拆分为 6 个模块：

| 模块                     | 内容                                                                       | 预估行数 |
| ------------------------ | -------------------------------------------------------------------------- | -------- |
| `visual-tool.types.ts`   | 类型定义 + 常量                                                            | ~150     |
| `visual-tool.parse.ts`   | 动作规范化、JSON 解析、辅助函数                                            | ~200     |
| `visual-tool.observe.ts` | observeBrowser, observeDesktop, 图像/文本提取                              | ~150     |
| `visual-tool.execute.ts` | executeBrowserDecision, executeDesktopDecision                             | ~250     |
| `visual-tool.loop.ts`    | runVisualLoop, buildVisualModelPrompt, runVisualModelDefault, withRetries  | ~400     |
| `visual-tool.ts`         | createVisualTool, resolveVisualConfig, schema, 安全检查, ensureDesktopNode | ~400     |

拆分原则：

- `visual-tool.ts` 保持为唯一公开入口
- `__testing` 导出从子模块 re-export
- 对外 API 完全不变

### G6：测试覆盖（P2）

**现状**：仅 7 个测试用例（含新增的 ensureDesktopNode 测试），桌面操作路径几乎无测试。

**方案**：补充以下测试：

- 解析层：normalizeVisualAction 所有别名、normalizeDecision 各种输入格式、extractJsonCandidate 边界情况
- 观察层：observeBrowser fallback 逻辑、observeDesktop 正常/异常路径
- 执行层：每种 browser/desktop 动作的参数校验和执行结果
- 集成层：step 模式、stop 操作、status 查询、dryRun、审批拦截、配置合并

### G7：跨平台支持（P3，后续）

**现状**：桌面操作仅支持 macOS。

**说明**：本期不在范围内。后续可通过以下路径扩展：

- Linux：xdotool + scrot/gnome-screenshot
- Windows：PowerShell + Win32 API / UIAutomation
- 通过 node-host 的命令分发机制，每个平台实现独立的 `invoke-desktop-{platform}.ts`

## 4. 实施计划

### 阶段 1：桌面感知增强（G1 + G2）

**目标**：让 VLM 在桌面模式下获得与 browser 模式接近的结构化信息，大幅提升坐标精度。

**交付物**：

1. `src/node-host/invoke-desktop.ts` 新增：
   - `desktop.accessibility_snapshot` 命令 — 通过 JXA 调用 AXUIElement API
   - 返回 UI 元素列表（类型、文本、坐标 bounds）
   - `desktop.snapshot` 增加返回分辨率和缩放信息

2. `src/agents/tools/visual-tool.ts`（或拆分后的 `visual-tool.observe.ts`）：
   - `observeDesktop` 调用 `desktop.accessibility_snapshot` 填充 `snapshotText`
   - fallback：如果 accessibility 不可用，使用 OCR 或返回空文本

3. `buildVisualModelPrompt` 桌面分支增强：
   - 加入分辨率、缩放比例
   - 加入 UI 元素列表
   - 加入坐标优先策略指导

**验收**：

- `observeDesktop` 返回的 `snapshotText` 包含可用的 UI 元素信息
- VLM 能根据元素列表更准确地输出坐标
- 对比增强前后在 3 个典型桌面任务上的成功率

**需要的 macOS 权限**：

- 辅助功能权限（System Preferences → Security & Privacy → Accessibility）
- 屏幕录制权限（已有，截图需要）

### 阶段 2：操作反馈 + Agent 指导（G3 + G4）

**目标**：用户通过渠道能看到操作进度；Agent 能更好地使用 visual-tool。

**交付物**：

1. `visual-tool` 增加进度回调机制：
   - `onProgress?: (event: VisualProgressEvent) => void` 回调参数
   - 事件类型：`started | action | completed | failed`
   - `action` 事件包含：轮次、动作类型、reason、截图（可选）

2. Agent 使用指导：
   - 更新 `visual` 工具的 `description`，明确何时用 `run` vs `step`
   - 编写 Agent system prompt 扩展片段，指导桌面任务分解策略

3. 工具描述优化：
   - 参数说明增加使用场景示例
   - 明确 browser/desktop target 的选择策略

**验收**：

- 用户通过飞书/Telegram 发送桌面任务，能在同一对话中收到进度更新
- Agent 能自主选择 visual-tool 并合理设置参数

### 阶段 3：代码质量（G5 + G6）

**目标**：visual-tool.ts 拆分为可维护的模块结构，补充测试覆盖。

**交付物**：

1. 文件拆分（6 个模块，每个 < 400 行）
2. 补充 20+ 测试用例覆盖关键路径
3. 保持对外 API 完全不变

**验收**：

- `pnpm test` 全部通过
- `pnpm build` 类型检查通过
- `pnpm check` lint/format 通过
- 插件 SDK 导出不变

## 5. 关键技术决策

### D1：Accessibility API 实现方式

使用 JXA（已有基础设施，`invoke-desktop.ts` 的所有桌面操作都通过 JXA 实现）调用 `Application("System Events")` 和底层 `ObjC.import("ApplicationServices")` 获取 AXUIElement 树。

```javascript
// JXA 伪代码
ObjC.import("ApplicationServices");
const app = $.AXUIElementCreateSystemWide();
const focusedApp = $.AXUIElementCopyAttributeValue(app, "AXFocusedApplication");
const window = $.AXUIElementCopyAttributeValue(focusedApp, "AXFocusedWindow");
// 递归遍历子元素，提取 role/title/value/position/size
```

### D2：snapshotText 格式

采用与 browser snapshot 类似的缩进文本格式，VLM 可直接理解：

```
[Window] "系统设置" (0, 38, 1200, 762)
  [Toolbar] (0, 38, 1200, 52)
    [Button] "关闭" (8, 44, 14, 14)
    [Button] "最小化" (28, 44, 14, 14)
    [SearchField] "搜索" (450, 44, 300, 28)
  [ScrollArea] (0, 90, 1200, 710)
    [Group] "通用" (20, 100, 180, 64)
      [Image] (40, 108, 48, 48)
      [StaticText] "通用" (96, 120, 60, 20)
    [Group] "外观" (220, 100, 180, 64)
      ...
```

### D3：坐标系统一致性

- `desktop.snapshot` 返回的截图尺寸是逻辑像素（已除以 scale factor）
- Accessibility API 返回的坐标也是逻辑像素
- 两者坐标系一致，VLM 输出的 x,y 可直接用于 `desktop.act`
- 在提示词中明确说明这一点，避免 VLM 混淆

### D4：进度回调不侵入渠道层

`visual-tool` 本身不知道消息渠道的存在。回调由调用方（agent runtime）提供：

```typescript
// Agent 调用 visual-tool 时
const result = await visualTool.execute(toolCallId, {
  action: "run",
  target: "desktop",
  goal: "打开系统设置",
  // onProgress 不是 visual-tool 的参数，
  // 而是通过 VisualToolDeps 或运行时上下文传入
});
```

具体方案：在 `createVisualTool` 的 `options` 中增加 `onLoopTrace` 回调，每轮循环结束后调用。调用方可以选择忽略或通过渠道回传。

### D5：不做独立入口

用户通过已有渠道与 Agent 对话，Agent 自主判断是否需要调用 visual-tool。这与其他工具（browser、nodes、message 等）的使用模式一致。不需要新的 CLI 命令或独立应用。

## 6. 风险与缓解

| 风险                                     | 影响                  | 缓解                                                                                 |
| ---------------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| macOS Accessibility API 权限难以自动获取 | 首次使用需手动授权    | 在 `desktop.accessibility_snapshot` 失败时 fallback 到纯截图模式，并返回权限引导信息 |
| 不同应用的 Accessibility 支持差异大      | 某些 app 元素树不完整 | 结合 OCR 补充；提示词中告知 VLM 元素列表可能不完整                                   |
| VLM 坐标输出仍不精确                     | 点击错误位置          | 重试机制已有；增加"点击后截图对比"检测是否成功                                       |
| 进度回调可能产生过多消息                 | 用户被打扰            | 频率控制：仅在关键节点发送（开始/完成/失败），中间动作聚合                           |
| 文件拆分影响现有功能                     | 回归风险              | 保持 API 不变；先补测试再拆分                                                        |

## 7. 阶段依赖关系

```
阶段 1（桌面感知增强）
  ├── G1：Accessibility API + OCR
  └── G2：提示词增强
          ↓
阶段 2（操作反馈 + Agent 指导）
  ├── G3：进度回调
  └── G4：工具描述优化
          ↓
阶段 3（代码质量）
  ├── G5：文件拆分
  └── G6：测试补充
```

阶段 1 是最关键的 — 桌面感知质量直接决定了操作成功率。阶段 2 和 3 可以并行推进。

## 8. 不在范围内

- 新建独立 CLI 命令或独立应用（复用现有渠道体系）
- 移动端/ADB 操作（后续单独立项）
- Linux/Windows 桌面操作（后续扩展）
- 自训练视觉模型（使用现有商业 VLM）
- Control UI 中的实时截图流展示（通过渠道消息回传已足够）
