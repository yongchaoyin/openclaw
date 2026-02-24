import type { AgentToolResult } from "@mariozechner/pi-agent-core";
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
  if (accessibilityResult) {
    const axDetails = asRecord(accessibilityResult.details);
    if (typeof axDetails.text === "string") {
      snapshotText = axDetails.text;
    }
  }

  return {
    capturedAt: params.now(),
    target: "desktop",
    image,
    snapshotText,
    meta: {
      ...(typeof details.width === "number" ? { width: details.width } : {}),
      ...(typeof details.height === "number" ? { height: details.height } : {}),
      ...(typeof details.screenWidth === "number" ? { screenWidth: details.screenWidth } : {}),
      ...(typeof details.screenHeight === "number" ? { screenHeight: details.screenHeight } : {}),
      ...(typeof details.scaleFactor === "number" ? { scaleFactor: details.scaleFactor } : {}),
      ...(typeof details.format === "string" ? { format: details.format } : {}),
    },
  };
}
