import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { DesktopAxRef } from "../../node-host/invoke-desktop.js";
import { annotateDesktopScreenshot } from "./visual-tool.annotate.js";
import { asRecord, extractToolImage, extractToolText } from "./visual-tool.parse.js";
import type { VisualImage, VisualObservation } from "./visual-tool.types.js";
import {
  DEFAULT_BROWSER_REFS,
  DEFAULT_BROWSER_SNAPSHOT_FORMAT,
  MAX_SNAPSHOT_TEXT,
} from "./visual-tool.types.js";

export async function observeBrowser(params: {
  executeBrowser: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
  targetId?: string;
  profile?: string;
  browserTarget?: "sandbox" | "host" | "node";
  node?: string;
  now: () => number;
}): Promise<VisualObservation> {
  const snapshotArgs: Record<string, unknown> = {
    action: "snapshot",
    snapshotFormat: DEFAULT_BROWSER_SNAPSHOT_FORMAT,
    labels: true,
    refs: DEFAULT_BROWSER_REFS,
    ...(params.targetId ? { targetId: params.targetId } : {}),
    ...(params.profile ? { profile: params.profile } : {}),
    ...(params.browserTarget ? { target: params.browserTarget } : {}),
    ...(params.node ? { node: params.node } : {}),
  };
  const snapshot = await params.executeBrowser(snapshotArgs);
  let image: VisualImage | null = extractToolImage(snapshot);
  if (!image) {
    const screenshot = await params.executeBrowser({
      action: "screenshot",
      ...(params.targetId ? { targetId: params.targetId } : {}),
      ...(params.profile ? { profile: params.profile } : {}),
      ...(params.browserTarget ? { target: params.browserTarget } : {}),
      ...(params.node ? { node: params.node } : {}),
      type: "png",
    });
    image = extractToolImage(screenshot);
  }
  if (!image) {
    throw new Error("browser observation did not return an image");
  }
  const snapshotText = extractToolText(snapshot).slice(0, MAX_SNAPSHOT_TEXT);
  const details = asRecord(snapshot.details);
  return {
    capturedAt: params.now(),
    target: "browser",
    image,
    snapshotText,
    meta: {
      ...(typeof details.targetId === "string" ? { targetId: details.targetId } : {}),
      ...(typeof details.url === "string" ? { url: details.url } : {}),
      ...(typeof details.labelsCount === "number" ? { labelsCount: details.labelsCount } : {}),
    },
  };
}

export async function observeDesktop(params: {
  executeNodes: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
  node: string;
  format: "png" | "jpeg";
  mainDisplayOnly?: boolean;
  maxWidth?: number;
  quality?: number;
  now: () => number;
}): Promise<VisualObservation> {
  // Run screenshot and accessibility snapshot in parallel for speed.
  // Accessibility snapshot is best-effort -- failures do not block the loop.
  const [result, accessibilityResult] = await Promise.all([
    params.executeNodes({
      action: "desktop_snapshot",
      node: params.node,
      format: params.format,
      ...(typeof params.mainDisplayOnly === "boolean"
        ? { mainDisplayOnly: params.mainDisplayOnly }
        : {}),
      ...(typeof params.maxWidth === "number" ? { maxWidth: params.maxWidth } : {}),
      ...(typeof params.quality === "number" ? { quality: params.quality } : {}),
    }),
    params
      .executeNodes({
        action: "desktop_accessibility_snapshot",
        node: params.node,
      })
      .catch(() => null),
  ]);
  const image = extractToolImage(result);
  if (!image) {
    throw new Error("desktop observation did not return an image");
  }
  const details = asRecord(result.details);

  // Build snapshot text from accessibility tree if available
  let snapshotText = "";
  let axRefs: unknown[] | undefined;
  if (accessibilityResult) {
    const axDetails = asRecord(accessibilityResult.details);
    if (typeof axDetails.text === "string") {
      snapshotText = axDetails.text;
    }
    if (Array.isArray(axDetails.axRefs) && axDetails.axRefs.length > 0) {
      axRefs = axDetails.axRefs;
    }
  }

  // Annotate screenshot with Set-of-Marks (orange boxes + ref labels) when
  // accessibility refs and dimension info are available. This lets VLMs visually
  // match ref labels on the screenshot instead of guessing pixel coordinates.
  const imageW = typeof details.width === "number" ? details.width : 0;
  const imageH = typeof details.height === "number" ? details.height : 0;
  const screenW = typeof details.screenWidth === "number" ? details.screenWidth : 0;
  const screenH = typeof details.screenHeight === "number" ? details.screenHeight : 0;

  let annotatedImage = image;
  if (axRefs && axRefs.length > 0 && imageW > 0 && imageH > 0 && screenW > 0 && screenH > 0) {
    try {
      annotatedImage = await annotateDesktopScreenshot({
        imageBase64: image.base64,
        mimeType: image.mimeType,
        axRefs: axRefs as DesktopAxRef[],
        imageWidth: imageW,
        imageHeight: imageH,
        screenWidth: screenW,
        screenHeight: screenH,
      });
    } catch {
      // Annotation failure is non-fatal — fall back to original screenshot
    }
  }

  return {
    capturedAt: params.now(),
    target: "desktop",
    image: annotatedImage,
    snapshotText,
    meta: {
      ...(imageW > 0 ? { width: imageW } : {}),
      ...(imageH > 0 ? { height: imageH } : {}),
      ...(screenW > 0 ? { screenWidth: screenW } : {}),
      ...(screenH > 0 ? { screenHeight: screenH } : {}),
      ...(typeof details.scaleFactor === "number" ? { scaleFactor: details.scaleFactor } : {}),
      ...(typeof details.format === "string" ? { format: details.format } : {}),
      ...(axRefs ? { axRefs } : {}),
    },
  };
}
