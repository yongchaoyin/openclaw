import type { DesktopAxRef } from "../../node-host/invoke-desktop.js";

type Sharp = typeof import("sharp");

/**
 * Draw Set-of-Marks annotations (orange bounding boxes + ref labels)
 * on a desktop screenshot using Sharp SVG composite.
 * Style matches browser mode (pw-tools-core.interactions.ts #ffb020).
 */
export async function annotateDesktopScreenshot(params: {
  imageBase64: string;
  mimeType: string;
  axRefs: DesktopAxRef[];
  /** Screenshot pixel width (after any resize) */
  imageWidth: number;
  imageHeight: number;
  /** Screen logical width */
  screenWidth: number;
  screenHeight: number;
}): Promise<{ base64: string; mimeType: string }> {
  if (!params.axRefs.length) {
    return { base64: params.imageBase64, mimeType: params.mimeType };
  }

  const mod = (await import("sharp")) as unknown as { default?: Sharp };
  const sharp = mod.default ?? (mod as unknown as Sharp);

  const scaleX = params.imageWidth / params.screenWidth;
  const scaleY = params.imageHeight / params.screenHeight;

  const svgParts: string[] = [];
  for (const ref of params.axRefs) {
    const x = Math.round(ref.bounds.x * scaleX);
    const y = Math.round(ref.bounds.y * scaleY);
    const w = Math.round(ref.bounds.w * scaleX);
    const h = Math.round(ref.bounds.h * scaleY);
    // Skip elements too small to annotate meaningfully
    if (w < 4 || h < 4) {
      continue;
    }

    // Label dimensions — monospace ~8px per char
    const tagW = ref.ref.length * 8 + 8;
    const tagH = 16;
    // Position label just above the element box; clamp to top of image
    const tagY = Math.max(0, y - tagH - 2);

    // Orange bounding box (#ffb020, matching browser SoM style)
    svgParts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ffb020" stroke-width="2"/>`,
    );
    // Ref label background
    svgParts.push(
      `<rect x="${x}" y="${tagY}" width="${tagW}" height="${tagH}" fill="#ffb020" rx="3"/>`,
    );
    // Ref text (escaped for SVG safety)
    const safeRef = escapeXml(ref.ref);
    svgParts.push(
      `<text x="${x + 4}" y="${tagY + 12}" font-family="monospace" font-size="12" fill="#1a1a1a">${safeRef}</text>`,
    );
  }

  if (!svgParts.length) {
    return { base64: params.imageBase64, mimeType: params.mimeType };
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

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
