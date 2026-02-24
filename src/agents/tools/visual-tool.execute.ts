import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { VisualDecision } from "./visual-tool.types.js";

export async function executeBrowserDecision(params: {
  executeBrowser: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
  decision: VisualDecision;
  targetId?: string;
  profile?: string;
  browserTarget?: "sandbox" | "host" | "node";
  node?: string;
}): Promise<unknown> {
  const baseArgs: Record<string, unknown> = {
    ...(params.targetId ? { targetId: params.targetId } : {}),
    ...(params.profile ? { profile: params.profile } : {}),
    ...(params.browserTarget ? { target: params.browserTarget } : {}),
    ...(params.node ? { node: params.node } : {}),
  };
  const decision = params.decision;
  const ref = decision.ref ?? decision.selector;

  switch (decision.kind) {
    case "click":
    case "doubleClick":
    case "rightClick": {
      if (!ref) {
        throw new Error("browser click actions require ref from snapshot");
      }
      const result = await params.executeBrowser({
        action: "act",
        ...baseArgs,
        request: {
          kind: "click",
          ref,
          ...(decision.kind === "doubleClick" ? { doubleClick: true } : {}),
          ...(decision.kind === "rightClick"
            ? { button: "right" }
            : decision.button
              ? { button: decision.button }
              : {}),
        },
      });
      return result.details;
    }
    case "move": {
      if (!ref) {
        throw new Error("browser move action requires ref from snapshot");
      }
      const result = await params.executeBrowser({
        action: "act",
        ...baseArgs,
        request: {
          kind: "hover",
          ref,
        },
      });
      return result.details;
    }
    case "drag": {
      if (!decision.startRef || !decision.endRef) {
        throw new Error("browser drag action requires startRef and endRef");
      }
      const result = await params.executeBrowser({
        action: "act",
        ...baseArgs,
        request: {
          kind: "drag",
          startRef: decision.startRef,
          endRef: decision.endRef,
        },
      });
      return result.details;
    }
    case "type": {
      if (!ref || !decision.text) {
        throw new Error("browser type action requires ref and text");
      }
      const result = await params.executeBrowser({
        action: "act",
        ...baseArgs,
        request: {
          kind: "type",
          ref,
          text: decision.text,
        },
      });
      return result.details;
    }
    case "hotkey": {
      const keys = decision.keys ?? [];
      if (!keys.length) {
        throw new Error("browser hotkey action requires keys");
      }
      const key = keys.length === 1 ? keys[0] : keys.join("+");
      const result = await params.executeBrowser({
        action: "act",
        ...baseArgs,
        request: {
          kind: "press",
          key,
        },
      });
      return result.details;
    }
    case "scroll": {
      const deltaX = decision.deltaX ?? 0;
      const deltaY = decision.deltaY ?? 0;
      if (deltaX === 0 && deltaY === 0) {
        throw new Error("browser scroll action requires deltaX or deltaY");
      }
      const result = await params.executeBrowser({
        action: "act",
        ...baseArgs,
        request: {
          kind: "evaluate",
          fn: `() => { window.scrollBy(${deltaX}, ${deltaY}); return { x: window.scrollX, y: window.scrollY }; }`,
        },
      });
      return result.details;
    }
    case "wait": {
      const timeMs =
        typeof decision.ms === "number" && Number.isFinite(decision.ms)
          ? Math.max(0, Math.floor(decision.ms))
          : 500;
      const result = await params.executeBrowser({
        action: "act",
        ...baseArgs,
        request: {
          kind: "wait",
          timeMs,
        },
      });
      return result.details;
    }
    case "navigate": {
      if (!decision.url) {
        throw new Error("browser navigate action requires url");
      }
      const result = await params.executeBrowser({
        action: "navigate",
        ...baseArgs,
        targetUrl: decision.url,
      });
      return result.details;
    }
    case "navigate_back": {
      const result = await params.executeBrowser({
        action: "act",
        ...baseArgs,
        request: {
          kind: "evaluate",
          fn: "() => { history.back(); return true; }",
        },
      });
      return result.details;
    }
    case "done":
      return { ok: true, kind: "done" };
  }
}

export async function executeDesktopDecision(params: {
  executeNodes: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
  node: string;
  decision: VisualDecision;
}): Promise<unknown> {
  const decision = params.decision;
  if (decision.kind === "navigate" || decision.kind === "navigate_back") {
    throw new Error(`desktop target does not support action kind "${decision.kind}"`);
  }

  const invokeParams: Record<string, unknown> = {
    action: "desktop_act",
    node: params.node,
    kind: decision.kind,
  };

  switch (decision.kind) {
    case "click":
    case "doubleClick":
    case "rightClick":
    case "move":
      if (typeof decision.x !== "number" || typeof decision.y !== "number") {
        throw new Error(`desktop ${decision.kind} action requires x and y`);
      }
      invokeParams.x = decision.x;
      invokeParams.y = decision.y;
      if (decision.button) {
        invokeParams.button = decision.button;
      }
      break;
    case "drag":
      if (
        typeof decision.fromX !== "number" ||
        typeof decision.fromY !== "number" ||
        typeof decision.toX !== "number" ||
        typeof decision.toY !== "number"
      ) {
        throw new Error("desktop drag action requires fromX/fromY/toX/toY");
      }
      invokeParams.fromX = decision.fromX;
      invokeParams.fromY = decision.fromY;
      invokeParams.toX = decision.toX;
      invokeParams.toY = decision.toY;
      break;
    case "type":
      if (!decision.text) {
        throw new Error("desktop type action requires text");
      }
      invokeParams.text = decision.text;
      break;
    case "hotkey":
      if (!decision.keys?.length) {
        throw new Error("desktop hotkey action requires keys");
      }
      invokeParams.keys = decision.keys;
      break;
    case "scroll":
      if ((decision.deltaX ?? 0) === 0 && (decision.deltaY ?? 0) === 0) {
        throw new Error("desktop scroll action requires deltaX or deltaY");
      }
      if (typeof decision.deltaX === "number") {
        invokeParams.deltaX = decision.deltaX;
      }
      if (typeof decision.deltaY === "number") {
        invokeParams.deltaY = decision.deltaY;
      }
      break;
    case "wait":
      if (typeof decision.ms === "number") {
        invokeParams.waitMs = Math.max(0, Math.floor(decision.ms));
      }
      break;
    case "done":
      break;
    default:
      break;
  }

  const result = await params.executeNodes(invokeParams);
  return result.details;
}
