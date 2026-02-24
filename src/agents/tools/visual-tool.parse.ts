import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
  VisualAction,
  VisualDecision,
  VisualImage,
  VisualLoopTrace,
} from "./visual-tool.types.js";
import { MAX_HISTORY_ITEMS } from "./visual-tool.types.js";

export function asFiniteInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.floor(value);
}

export function readBoundedInt(params: {
  value: unknown;
  label: string;
  min: number;
  max?: number;
}): number | undefined {
  const numeric = asFiniteInteger(params.value);
  if (numeric === undefined) {
    return undefined;
  }
  if (numeric < params.min) {
    throw new Error(`${params.label} must be >= ${params.min}`);
  }
  if (typeof params.max === "number" && numeric > params.max) {
    throw new Error(`${params.label} must be <= ${params.max}`);
  }
  return numeric;
}

export function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

export function normalizeVisualAction(raw: string): VisualAction | null {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "click":
      return "click";
    case "doubleclick":
    case "double_click":
      return "doubleClick";
    case "rightclick":
    case "right_click":
      return "rightClick";
    case "move":
      return "move";
    case "drag":
      return "drag";
    case "type":
      return "type";
    case "hotkey":
      return "hotkey";
    case "scroll":
      return "scroll";
    case "wait":
      return "wait";
    case "navigate":
      return "navigate";
    case "navigateback":
    case "navigate_back":
    case "back":
      return "navigate_back";
    case "done":
    case "finish":
    case "finished":
      return "done";
    default:
      return null;
  }
}

export function normalizeButton(value: unknown): "left" | "right" | "middle" | undefined {
  const normalized = trimToUndefined(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "left" || normalized === "right" || normalized === "middle") {
    return normalized;
  }
  return undefined;
}

export function normalizeDecision(value: unknown): VisualDecision {
  const obj = asRecord(value);
  const rawKind =
    trimToUndefined(obj.kind) ?? trimToUndefined(obj.action) ?? trimToUndefined(obj.type) ?? "";
  const kind = normalizeVisualAction(rawKind);
  if (!kind) {
    throw new Error(
      "visual model returned unsupported action kind. Expected one of click/doubleClick/rightClick/move/drag/type/hotkey/scroll/wait/navigate/navigate_back/done.",
    );
  }
  const parseNum = (input: unknown) =>
    typeof input === "number" && Number.isFinite(input) ? input : undefined;
  const keysRaw = Array.isArray(obj.keys) ? obj.keys.map((entry) => String(entry).trim()) : [];
  const keys = keysRaw.filter(Boolean);

  const targetObj = asRecord(obj.target);
  return {
    kind,
    reason: trimToUndefined(obj.reason),
    ref: trimToUndefined(obj.ref) ?? trimToUndefined(targetObj.ref),
    selector: trimToUndefined(obj.selector) ?? trimToUndefined(targetObj.selector),
    x: parseNum(obj.x) ?? parseNum(targetObj.x),
    y: parseNum(obj.y) ?? parseNum(targetObj.y),
    fromX: parseNum(obj.fromX),
    fromY: parseNum(obj.fromY),
    toX: parseNum(obj.toX),
    toY: parseNum(obj.toY),
    startRef: trimToUndefined(obj.startRef) ?? trimToUndefined(targetObj.startRef),
    endRef: trimToUndefined(obj.endRef) ?? trimToUndefined(targetObj.endRef),
    text: trimToUndefined(obj.text),
    keys: keys.length > 0 ? keys : undefined,
    deltaX: parseNum(obj.deltaX),
    deltaY: parseNum(obj.deltaY),
    ms: parseNum(obj.ms) ?? parseNum(obj.waitMs),
    button: normalizeButton(obj.button),
    url: trimToUndefined(obj.url) ?? trimToUndefined(obj.targetUrl),
  };
}

export function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const fenced = fenceMatch[1].trim();
    if (fenced.startsWith("{") && fenced.endsWith("}")) {
      return fenced;
    }
  }
  const start = trimmed.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function parseVisualDecisionFromText(text: string): VisualDecision {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    throw new Error("visual model did not return JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`visual model returned invalid JSON: ${message}`, {
      cause: err,
    });
  }
  return normalizeDecision(parsed);
}

export function extractToolText(result: AgentToolResult<unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const blocks = content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const typed = block as { type?: unknown; text?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        return typed.text;
      }
      return "";
    })
    .filter(Boolean);
  return blocks.join("\n").trim();
}

export function extractToolImage(result: AgentToolResult<unknown>): VisualImage | null {
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typed = block as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (typed.type !== "image") {
      continue;
    }
    if (typeof typed.data !== "string" || !typed.data.trim()) {
      continue;
    }
    const mimeType =
      typeof typed.mimeType === "string" && typed.mimeType.trim()
        ? typed.mimeType.trim()
        : "image/png";
    return {
      base64: typed.data,
      mimeType,
    };
  }
  return null;
}

export function summarizeTrace(trace: VisualLoopTrace[]): string {
  const tail = trace.slice(-MAX_HISTORY_ITEMS);
  if (tail.length === 0) {
    return "none";
  }
  return tail
    .map(
      (entry) =>
        `#${entry.loop} ${entry.decision.kind} (${entry.outcome})${entry.error ? ` err=${entry.error}` : ""}`,
    )
    .join("; ");
}
