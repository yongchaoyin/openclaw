import crypto from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Api, type Context, complete, type Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { VisualToolsConfig } from "../../config/types.tools.js";
import { parseNodeList } from "../../shared/node-list-parse.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { resolveAgentConfig, resolveSessionAgentId } from "../agent-scope.js";
import { minimaxUnderstandImage } from "../minimax-vlm.js";
import { getApiKeyForModel, requireApiKey } from "../model-auth.js";
import { runWithImageModelFallback } from "../model-fallback.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { createBrowserTool } from "./browser-tool.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { coerceImageAssistantText, coerceImageModelConfig } from "./image-tool.helpers.js";
import { createNodesTool } from "./nodes-tool.js";

const VISUAL_TOOL_ACTIONS = ["run", "step", "stop", "status"] as const;
const VISUAL_TARGETS = ["browser", "desktop"] as const;
const VISUAL_BROWSER_TARGETS = ["sandbox", "host", "node"] as const;
const VISUAL_SNAPSHOT_FORMATS = ["png", "jpeg"] as const;
const VISUAL_APPROVAL_ACTIONS = [
  "click",
  "doubleClick",
  "rightClick",
  "move",
  "drag",
  "type",
  "hotkey",
  "scroll",
  "wait",
  "navigate",
  "navigate_back",
  "done",
] as const;

const DEFAULT_MAX_LOOP_COUNT = 100;
const MIN_MAX_LOOP_COUNT = 25;
const MAX_MAX_LOOP_COUNT = 200;
const DEFAULT_LOOP_INTERVAL_IN_MS = 1000;
const MAX_LOOP_INTERVAL_IN_MS = 3000;
const DEFAULT_CONTEXT_MAX_IMAGES = 5;
const MIN_CONTEXT_MAX_IMAGES = 1;
const MAX_CONTEXT_MAX_IMAGES = 10;
const DEFAULT_RETRY_MODEL = 5;
const DEFAULT_RETRY_SCREENSHOT = 5;
const DEFAULT_RETRY_EXECUTE = 1;
const MAX_TRACE_RECORDS = 30;
const MAX_DECISION_TEXT = 8_000;
const MAX_SNAPSHOT_TEXT = 12_000;
const MAX_HISTORY_ITEMS = 12;
const DEFAULT_BROWSER_REFS = "aria";
const DEFAULT_BROWSER_SNAPSHOT_FORMAT = "ai";
const MINIMAX_VISUAL_DEFAULT_MODEL = "minimax/MiniMax-VL-01";

type VisualAction = (typeof VISUAL_APPROVAL_ACTIONS)[number];
type VisualToolAction = (typeof VISUAL_TOOL_ACTIONS)[number];
type VisualTarget = (typeof VISUAL_TARGETS)[number];

type VisualImage = {
  base64: string;
  mimeType: string;
};

type VisualObservation = {
  capturedAt: number;
  target: VisualTarget;
  image: VisualImage;
  snapshotText?: string;
  meta?: Record<string, unknown>;
};

type VisualDecision = {
  kind: VisualAction;
  reason?: string;
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  startRef?: string;
  endRef?: string;
  text?: string;
  keys?: string[];
  deltaX?: number;
  deltaY?: number;
  ms?: number;
  button?: "left" | "right" | "middle";
  url?: string;
};

type VisualModelResponse = {
  text: string;
  provider: string;
  model: string;
  attempts: Array<{ provider: string; model: string; error: string }>;
};

type VisualLoopTrace = {
  loop: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  observe: {
    attempts: number;
    target: VisualTarget;
    snapshotTextChars: number;
    imageMimeType: string;
    capturedAt: number;
  };
  decision: {
    attempts: number;
    provider: string;
    model: string;
    kind: VisualAction;
    reason?: string;
    rawText: string;
  };
  execute?: {
    attempts: number;
    skipped?: boolean;
    result?: unknown;
  };
  outcome: "executed" | "done" | "failed";
  error?: string;
};

type VisualRunRecord = {
  runId: string;
  status: "running" | "completed" | "stopped" | "failed";
  action: VisualToolAction;
  target: VisualTarget;
  goal: string;
  startedAt: number;
  finishedAt?: number;
  loopCount: number;
  trace: VisualLoopTrace[];
  stopRequested: boolean;
  error?: string;
};

type VisualRuntimeConfig = {
  enabled: boolean;
  model?: string;
  maxLoopCount: number;
  loopIntervalInMs: number;
  contextMaxImages: number;
  retryModel: number;
  retryScreenshot: number;
  retryExecute: number;
  allowBrowser: boolean;
  allowDesktop: boolean;
  requireApprovalActions: Set<VisualAction>;
  screenshotUploadPolicy: "model" | "none";
};

type VisualLoopSettings = {
  runId: string;
  action: "run" | "step";
  goal: string;
  target: VisualTarget;
  node?: string;
  targetId?: string;
  profile?: string;
  browserTarget?: "sandbox" | "host" | "node";
  startUrl?: string;
  dryRun: boolean;
  includeTrace: boolean;
  maxLoopCount: number;
  loopIntervalInMs: number;
  contextMaxImages: number;
  retryModel: number;
  retryScreenshot: number;
  retryExecute: number;
  desktopFormat: "png" | "jpeg";
  desktopMainDisplayOnly?: boolean;
  desktopMaxWidth?: number;
  desktopQuality?: number;
};

type VisualDecisionPromptInput = {
  target: VisualTarget;
  goal: string;
  loop: number;
  maxLoopCount: number;
  observation: VisualObservation;
  previousTrace: VisualLoopTrace[];
};

type VisualToolDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  runVisualModel?: (input: {
    cfg?: OpenClawConfig;
    agentDir?: string;
    modelOverride?: string;
    prompt: string;
    images: VisualImage[];
  }) => Promise<VisualModelResponse>;
  executeBrowser?: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
  executeNodes?: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
  createRunId?: () => string;
};

const VisualToolSchema = Type.Object({
  action: stringEnum(VISUAL_TOOL_ACTIONS),
  goal: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),
  target: optionalStringEnum(VISUAL_TARGETS),
  node: Type.Optional(Type.String()),
  targetId: Type.Optional(Type.String()),
  profile: Type.Optional(Type.String()),
  browserTarget: optionalStringEnum(VISUAL_BROWSER_TARGETS),
  startUrl: Type.Optional(Type.String()),
  maxLoopCount: Type.Optional(Type.Number()),
  loopIntervalInMs: Type.Optional(Type.Number()),
  contextMaxImages: Type.Optional(Type.Number()),
  retryModel: Type.Optional(Type.Number()),
  retryScreenshot: Type.Optional(Type.Number()),
  retryExecute: Type.Optional(Type.Number()),
  dryRun: Type.Optional(Type.Boolean()),
  includeTrace: Type.Optional(Type.Boolean()),
  desktopFormat: optionalStringEnum(VISUAL_SNAPSHOT_FORMATS),
  desktopMainDisplayOnly: Type.Optional(Type.Boolean()),
  desktopMaxWidth: Type.Optional(Type.Number()),
  desktopQuality: Type.Optional(Type.Number()),
});

const visualRuns = new Map<string, VisualRunRecord>();

function asFiniteInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.floor(value);
}

function readBoundedInt(params: {
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

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeVisualAction(raw: string): VisualAction | null {
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

function normalizeButton(value: unknown): "left" | "right" | "middle" | undefined {
  const normalized = trimToUndefined(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "left" || normalized === "right" || normalized === "middle") {
    return normalized;
  }
  return undefined;
}

function normalizeDecision(value: unknown): VisualDecision {
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

function extractJsonCandidate(text: string): string | null {
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

function parseVisualDecisionFromText(text: string): VisualDecision {
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

function extractToolText(result: AgentToolResult<unknown>): string {
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

function extractToolImage(result: AgentToolResult<unknown>): VisualImage | null {
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

function summarizeTrace(trace: VisualLoopTrace[]): string {
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

function buildVisualModelPrompt(input: VisualDecisionPromptInput): string {
  const allowed =
    input.target === "browser"
      ? "click, doubleClick, rightClick, move, drag, type, hotkey, scroll, wait, navigate, navigate_back, done"
      : "click, doubleClick, rightClick, move, drag, type, hotkey, scroll, wait, done";
  const snapshotText = (input.observation.snapshotText ?? "").slice(0, MAX_SNAPSHOT_TEXT);
  const recentTrace = summarizeTrace(input.previousTrace);
  const sharedRules = [
    "You are a visual operator.",
    "Decide the next SINGLE action needed to progress toward the goal.",
    "Return ONLY a JSON object. No markdown, no prose.",
    `Allowed kinds: ${allowed}.`,
    "If the task is complete, return kind=done.",
    "Never invent unsupported actions.",
  ];

  const browserRules =
    input.target === "browser"
      ? [
          "Prefer using ref from the latest browser snapshot for interactions.",
          "Use navigate only for URL changes.",
          "Use navigate_back for browser back navigation.",
        ]
      : [
          "Desktop actions rely on screen coordinates.",
          "Use x/y for clicks and move; fromX/fromY/toX/toY for drag.",
        ];

  return [
    ...sharedRules,
    ...browserRules,
    "",
    `Goal: ${input.goal}`,
    `Loop: ${input.loop}/${input.maxLoopCount}`,
    `Recent actions: ${recentTrace}`,
    "",
    "Latest snapshot text:",
    snapshotText || "(none)",
    "",
    "JSON schema:",
    `{"kind":"<allowed>","reason":"<short reason>","ref":"<optional>","selector":"<optional>","x":0,"y":0,"fromX":0,"fromY":0,"toX":0,"toY":0,"startRef":"<optional>","endRef":"<optional>","text":"<optional>","keys":["<optional>"],"deltaX":0,"deltaY":0,"ms":250,"button":"left|right|middle","url":"https://..."}`,
  ].join("\n");
}

async function runVisualModelDefault(input: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  modelOverride?: string;
  prompt: string;
  images: VisualImage[];
}): Promise<VisualModelResponse> {
  const cfg = input.cfg;
  const agentDir = input.agentDir?.trim();
  if (!agentDir) {
    throw new Error("visual model execution requires agentDir");
  }
  if (!input.images.length) {
    throw new Error("visual model execution requires at least one image");
  }

  const imageModelConfig = coerceImageModelConfig(cfg);
  if (!imageModelConfig.primary && (imageModelConfig.fallbacks ?? []).length === 0) {
    if (!input.modelOverride?.trim()) {
      throw new Error(
        "No image model configured. Set agents.defaults.imageModel.primary (or tools.visual.model override).",
      );
    }
  }

  await ensureOpenClawModelsJson(cfg, agentDir);
  const authStorage = discoverAuthStorage(agentDir);
  const modelRegistry = discoverModels(authStorage, agentDir);

  const result = await runWithImageModelFallback({
    cfg,
    modelOverride: input.modelOverride,
    run: async (provider, modelId) => {
      const resolvedModelId =
        provider === "minimax" && !modelId.trim() ? MINIMAX_VISUAL_DEFAULT_MODEL : modelId;
      const model = modelRegistry.find(provider, resolvedModelId) as Model<Api> | null;
      if (!model) {
        throw new Error(`Unknown visual model: ${provider}/${resolvedModelId}`);
      }
      if (!model.input?.includes("image")) {
        throw new Error(`Visual model does not support images: ${provider}/${resolvedModelId}`);
      }
      const auth = await getApiKeyForModel({ model, cfg, agentDir });
      const apiKey = requireApiKey(auth, model.provider);
      authStorage.setRuntimeApiKey(model.provider, apiKey);

      if (model.provider === "minimax") {
        const firstImage = input.images[0];
        const text = await minimaxUnderstandImage({
          apiKey,
          prompt: input.prompt,
          imageDataUrl: `data:${firstImage.mimeType};base64,${firstImage.base64}`,
          modelBaseUrl: model.baseUrl,
        });
        return {
          text,
          provider: model.provider,
          model: model.id,
        };
      }

      const messageInput: Context = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: input.prompt },
              ...input.images.map((image) => ({
                type: "image" as const,
                data: image.base64,
                mimeType: image.mimeType,
              })),
            ],
            timestamp: Date.now(),
          },
        ],
      };
      const message = await complete(model, messageInput, {
        apiKey,
        maxTokens: 900,
        temperature: 0,
      });
      const text = coerceImageAssistantText({
        message,
        provider: model.provider,
        model: model.id,
      });
      return {
        text,
        provider: model.provider,
        model: model.id,
      };
    },
  });

  return {
    text: result.result.text,
    provider: result.result.provider,
    model: result.result.model,
    attempts: result.attempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      error: attempt.error,
    })),
  };
}

async function withRetries<T>(params: {
  label: string;
  retries: number;
  task: () => Promise<T>;
}): Promise<{ value: T; attempts: number }> {
  let attempt = 0;
  let lastError: unknown;
  const maxAttempts = Math.max(1, Math.floor(params.retries) + 1);
  while (attempt < maxAttempts) {
    try {
      const value = await params.task();
      return { value, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      attempt += 1;
      if (attempt >= maxAttempts) {
        break;
      }
    }
  }
  const message =
    lastError instanceof Error ? lastError.message : `${params.label} failed after retries`;
  throw new Error(`${params.label} failed after ${maxAttempts} attempts: ${message}`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

function resolveVisualConfig(params: {
  cfg?: OpenClawConfig;
  agentSessionKey?: string;
}): VisualRuntimeConfig {
  const cfg = params.cfg;
  const agentId = resolveSessionAgentId({
    sessionKey: params.agentSessionKey,
    config: cfg,
  });
  const globalConfig = cfg?.tools?.visual;
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId)?.tools?.visual : undefined;

  const merged: VisualToolsConfig = {
    ...globalConfig,
    ...agentConfig,
    context: {
      ...globalConfig?.context,
      ...agentConfig?.context,
    },
    retry: {
      ...globalConfig?.retry,
      ...agentConfig?.retry,
    },
    targets: {
      ...globalConfig?.targets,
      ...agentConfig?.targets,
    },
    safety: {
      ...globalConfig?.safety,
      ...agentConfig?.safety,
    },
    data: {
      ...globalConfig?.data,
      ...agentConfig?.data,
    },
  };

  const maxLoopCount = merged.maxLoopCount ?? DEFAULT_MAX_LOOP_COUNT;
  if (maxLoopCount < MIN_MAX_LOOP_COUNT || maxLoopCount > MAX_MAX_LOOP_COUNT) {
    throw new Error(
      `tools.visual.maxLoopCount must be within ${MIN_MAX_LOOP_COUNT}-${MAX_MAX_LOOP_COUNT}`,
    );
  }
  const loopIntervalInMs = merged.loopIntervalInMs ?? DEFAULT_LOOP_INTERVAL_IN_MS;
  if (loopIntervalInMs < 0 || loopIntervalInMs > MAX_LOOP_INTERVAL_IN_MS) {
    throw new Error(`tools.visual.loopIntervalInMs must be within 0-${MAX_LOOP_INTERVAL_IN_MS}`);
  }
  const contextMaxImages = merged.context?.maxImages ?? DEFAULT_CONTEXT_MAX_IMAGES;
  if (contextMaxImages < MIN_CONTEXT_MAX_IMAGES || contextMaxImages > MAX_CONTEXT_MAX_IMAGES) {
    throw new Error(
      `tools.visual.context.maxImages must be within ${MIN_CONTEXT_MAX_IMAGES}-${MAX_CONTEXT_MAX_IMAGES}`,
    );
  }
  const retryModel = merged.retry?.model ?? DEFAULT_RETRY_MODEL;
  const retryScreenshot = merged.retry?.screenshot ?? DEFAULT_RETRY_SCREENSHOT;
  const retryExecute = merged.retry?.execute ?? DEFAULT_RETRY_EXECUTE;
  if (retryModel < 0 || retryScreenshot < 0 || retryExecute < 0) {
    throw new Error("tools.visual.retry values must be >= 0");
  }
  const requireApprovalActions = new Set<VisualAction>();
  for (const raw of merged.safety?.requireApprovalActions ?? []) {
    const normalized = normalizeVisualAction(raw);
    if (normalized) {
      requireApprovalActions.add(normalized);
    }
  }

  return {
    enabled: merged.enabled !== false,
    model: trimToUndefined(merged.model),
    maxLoopCount,
    loopIntervalInMs,
    contextMaxImages,
    retryModel: Math.floor(retryModel),
    retryScreenshot: Math.floor(retryScreenshot),
    retryExecute: Math.floor(retryExecute),
    allowBrowser: merged.targets?.browser !== false,
    allowDesktop: merged.targets?.desktop !== false,
    requireApprovalActions,
    screenshotUploadPolicy: merged.data?.screenshotUploadPolicy ?? "model",
  };
}

function resolveLoopSettings(
  params: {
    args: Record<string, unknown>;
    runtime: VisualRuntimeConfig;
  },
  defaultRunId: string,
): VisualLoopSettings {
  const action = readStringParam(params.args, "action", {
    required: true,
  }) as VisualToolAction;
  const stepMode = action === "step";
  const targetRaw = trimToUndefined(params.args.target)?.toLowerCase();
  const target: VisualTarget = targetRaw === "desktop" ? "desktop" : "browser";
  const goal = readStringParam(params.args, "goal", { required: true });
  const runId = readStringParam(params.args, "runId") ?? defaultRunId;
  // Step mode always uses a single loop; ignore any explicit maxLoopCount to avoid
  // rejecting helper clients that set it to 1.
  const maxLoopCountOverride = stepMode
    ? undefined
    : readBoundedInt({
        value: params.args.maxLoopCount,
        label: "maxLoopCount",
        min: MIN_MAX_LOOP_COUNT,
        max: MAX_MAX_LOOP_COUNT,
      });
  const loopIntervalInMsOverride = readBoundedInt({
    value: params.args.loopIntervalInMs,
    label: "loopIntervalInMs",
    min: 0,
    max: MAX_LOOP_INTERVAL_IN_MS,
  });
  const contextMaxImagesOverride = readBoundedInt({
    value: params.args.contextMaxImages,
    label: "contextMaxImages",
    min: MIN_CONTEXT_MAX_IMAGES,
    max: MAX_CONTEXT_MAX_IMAGES,
  });
  const retryModel = readBoundedInt({
    value: params.args.retryModel,
    label: "retryModel",
    min: 0,
  });
  const retryScreenshot = readBoundedInt({
    value: params.args.retryScreenshot,
    label: "retryScreenshot",
    min: 0,
  });
  const retryExecute = readBoundedInt({
    value: params.args.retryExecute,
    label: "retryExecute",
    min: 0,
  });
  const desktopFormatRaw = trimToUndefined(params.args.desktopFormat)?.toLowerCase();
  const desktopFormat = desktopFormatRaw === "jpeg" ? "jpeg" : "png";

  return {
    runId,
    action: stepMode ? "step" : "run",
    goal,
    target,
    node: trimToUndefined(params.args.node),
    targetId: trimToUndefined(params.args.targetId),
    profile: trimToUndefined(params.args.profile),
    browserTarget:
      (trimToUndefined(params.args.browserTarget) as "sandbox" | "host" | "node" | undefined) ??
      undefined,
    startUrl: trimToUndefined(params.args.startUrl),
    dryRun: params.args.dryRun === true,
    includeTrace: params.args.includeTrace !== false,
    maxLoopCount: stepMode ? 1 : (maxLoopCountOverride ?? params.runtime.maxLoopCount),
    loopIntervalInMs: loopIntervalInMsOverride ?? params.runtime.loopIntervalInMs,
    contextMaxImages: contextMaxImagesOverride ?? params.runtime.contextMaxImages,
    retryModel: retryModel ?? params.runtime.retryModel,
    retryScreenshot: retryScreenshot ?? params.runtime.retryScreenshot,
    retryExecute: retryExecute ?? params.runtime.retryExecute,
    desktopFormat,
    desktopMainDisplayOnly:
      typeof params.args.desktopMainDisplayOnly === "boolean"
        ? params.args.desktopMainDisplayOnly
        : undefined,
    desktopMaxWidth: readBoundedInt({
      value: params.args.desktopMaxWidth,
      label: "desktopMaxWidth",
      min: 1,
    }),
    desktopQuality:
      typeof params.args.desktopQuality === "number" && Number.isFinite(params.args.desktopQuality)
        ? params.args.desktopQuality
        : undefined,
  };
}

function ensureTargetAllowed(target: VisualTarget, runtime: VisualRuntimeConfig) {
  if (target === "browser" && !runtime.allowBrowser) {
    throw new Error("visual target browser is disabled by tools.visual.targets.browser=false");
  }
  if (target === "desktop" && !runtime.allowDesktop) {
    throw new Error("visual target desktop is disabled by tools.visual.targets.desktop=false");
  }
}

function ensureImageUploadsEnabled(runtime: VisualRuntimeConfig) {
  if (runtime.screenshotUploadPolicy === "none") {
    throw new Error(
      "visual screenshots are blocked by tools.visual.data.screenshotUploadPolicy=none",
    );
  }
}

function checkApprovalAction(runtime: VisualRuntimeConfig, decision: VisualDecision) {
  if (!runtime.requireApprovalActions.has(decision.kind)) {
    return;
  }
  throw new Error(
    `visual action "${decision.kind}" requires approval (tools.visual.safety.requireApprovalActions)`,
  );
}

function trimRunsStore() {
  if (visualRuns.size <= MAX_TRACE_RECORDS) {
    return;
  }
  const entries = [...visualRuns.values()].toSorted((a, b) => a.startedAt - b.startedAt);
  const removeCount = visualRuns.size - MAX_TRACE_RECORDS;
  for (let i = 0; i < removeCount; i += 1) {
    const run = entries[i];
    if (run) {
      visualRuns.delete(run.runId);
    }
  }
}

function formatNodeLabel(node: NodeListNode): string {
  const name = typeof node.displayName === "string" ? node.displayName.trim() : "";
  const base = name || node.nodeId;
  const status =
    node.connected === true ? "online" : node.connected === false ? "offline" : "unknown";
  return `${base} (${status})`;
}

function supportsDesktopNode(node: NodeListNode): boolean {
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return (
    caps.includes("desktop") ||
    commands.includes("desktop.snapshot") ||
    commands.includes("desktop.act")
  );
}

function pickDesktopNode(nodes: NodeListNode[]): NodeListNode | null {
  const desktopNodes = nodes.filter((node) => supportsDesktopNode(node));
  if (desktopNodes.length === 0) {
    return null;
  }

  const connected = desktopNodes.filter((node) => node.connected);
  const connectedCandidates = connected.length > 0 ? connected : desktopNodes;
  if (connectedCandidates.length === 1) {
    return connectedCandidates[0];
  }

  const local = connectedCandidates.filter((node) => {
    const platform = typeof node.platform === "string" ? node.platform.toLowerCase() : "";
    return (
      platform === "darwin" ||
      platform.startsWith("mac") ||
      (typeof node.nodeId === "string" && node.nodeId.startsWith("mac-"))
    );
  });
  if (local.length === 1) {
    return local[0];
  }

  return null;
}

function buildDesktopNodeMissingMessage(nodes: NodeListNode[]): string {
  if (nodes.length === 0) {
    return "visual desktop target requires node (no nodes connected)";
  }

  const desktopNodes = nodes.filter((node) => supportsDesktopNode(node));
  if (desktopNodes.length === 0) {
    return "visual desktop target requires node (no desktop-capable nodes connected)";
  }

  const connected = desktopNodes.filter((node) => node.connected);
  const candidates = connected.length > 0 ? connected : desktopNodes;
  const labels = candidates.map(formatNodeLabel).filter(Boolean);
  if (labels.length === 0) {
    return "visual desktop target requires node";
  }
  return `visual desktop target requires node (available nodes: ${labels.join(", ")})`;
}

async function ensureDesktopNode(params: {
  settings: VisualLoopSettings;
  executeNodes: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
}): Promise<VisualLoopSettings> {
  if (params.settings.target !== "desktop") {
    return params.settings;
  }
  const explicit = params.settings.node?.trim();
  if (explicit) {
    return params.settings;
  }

  const status = await params.executeNodes({ action: "status" });
  const nodes = parseNodeList(status.details);
  const picked = pickDesktopNode(nodes);
  if (picked) {
    return { ...params.settings, node: picked.nodeId };
  }
  throw new Error(buildDesktopNodeMissingMessage(nodes));
}

async function observeBrowser(params: {
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
  let image = extractToolImage(snapshot);
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

async function observeDesktop(params: {
  executeNodes: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
  node: string;
  format: "png" | "jpeg";
  mainDisplayOnly?: boolean;
  maxWidth?: number;
  quality?: number;
  now: () => number;
}): Promise<VisualObservation> {
  const result = await params.executeNodes({
    action: "desktop_snapshot",
    node: params.node,
    format: params.format,
    ...(typeof params.mainDisplayOnly === "boolean"
      ? { mainDisplayOnly: params.mainDisplayOnly }
      : {}),
    ...(typeof params.maxWidth === "number" ? { maxWidth: params.maxWidth } : {}),
    ...(typeof params.quality === "number" ? { quality: params.quality } : {}),
  });
  const image = extractToolImage(result);
  if (!image) {
    throw new Error("desktop observation did not return an image");
  }
  const details = asRecord(result.details);
  return {
    capturedAt: params.now(),
    target: "desktop",
    image,
    snapshotText: "",
    meta: {
      ...(typeof details.width === "number" ? { width: details.width } : {}),
      ...(typeof details.height === "number" ? { height: details.height } : {}),
      ...(typeof details.format === "string" ? { format: details.format } : {}),
    },
  };
}

async function executeBrowserDecision(params: {
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

async function executeDesktopDecision(params: {
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

async function runVisualLoop(params: {
  runtime: VisualRuntimeConfig;
  settings: VisualLoopSettings;
  record: VisualRunRecord;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  runVisualModel: (input: {
    cfg?: OpenClawConfig;
    agentDir?: string;
    modelOverride?: string;
    prompt: string;
    images: VisualImage[];
  }) => Promise<VisualModelResponse>;
  executeBrowser: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
  executeNodes: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
  cfg?: OpenClawConfig;
  agentDir?: string;
}) {
  const contextImages: VisualImage[] = [];
  const pushContextImage = (image: VisualImage) => {
    contextImages.push(image);
    while (contextImages.length > params.settings.contextMaxImages) {
      contextImages.shift();
    }
  };

  if (params.settings.target === "browser" && params.settings.startUrl) {
    await params.executeBrowser({
      action: "navigate",
      ...(params.settings.browserTarget ? { target: params.settings.browserTarget } : {}),
      ...(params.settings.node ? { node: params.settings.node } : {}),
      ...(params.settings.targetId ? { targetId: params.settings.targetId } : {}),
      ...(params.settings.profile ? { profile: params.settings.profile } : {}),
      targetUrl: params.settings.startUrl,
    });
  }

  for (let loop = 1; loop <= params.settings.maxLoopCount; loop += 1) {
    if (params.record.stopRequested) {
      params.record.status = "stopped";
      params.record.finishedAt = params.now();
      params.record.loopCount = loop - 1;
      return;
    }
    const startedAt = params.now();
    const trace: VisualLoopTrace = {
      loop,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      observe: {
        attempts: 0,
        target: params.settings.target,
        snapshotTextChars: 0,
        imageMimeType: "",
        capturedAt: startedAt,
      },
      decision: {
        attempts: 0,
        provider: "",
        model: "",
        kind: "wait",
        rawText: "",
      },
      outcome: "failed",
    };

    try {
      const observed = await withRetries({
        label: "visual observe",
        retries: params.settings.retryScreenshot,
        task: async () => {
          if (params.settings.target === "browser") {
            return await observeBrowser({
              executeBrowser: params.executeBrowser,
              targetId: params.settings.targetId,
              profile: params.settings.profile,
              browserTarget: params.settings.browserTarget,
              node: params.settings.node,
              now: params.now,
            });
          }
          const node = params.settings.node?.trim();
          if (!node) {
            throw new Error("visual desktop target requires node");
          }
          return await observeDesktop({
            executeNodes: params.executeNodes,
            node,
            format: params.settings.desktopFormat,
            mainDisplayOnly: params.settings.desktopMainDisplayOnly,
            maxWidth: params.settings.desktopMaxWidth,
            quality: params.settings.desktopQuality,
            now: params.now,
          });
        },
      });

      trace.observe.attempts = observed.attempts;
      trace.observe.capturedAt = observed.value.capturedAt;
      trace.observe.snapshotTextChars = observed.value.snapshotText?.length ?? 0;
      trace.observe.imageMimeType = observed.value.image.mimeType;
      pushContextImage(observed.value.image);

      const prompt = buildVisualModelPrompt({
        target: params.settings.target,
        goal: params.settings.goal,
        loop,
        maxLoopCount: params.settings.maxLoopCount,
        observation: observed.value,
        previousTrace: params.record.trace,
      });

      const modelResult = await withRetries({
        label: "visual model",
        retries: params.settings.retryModel,
        task: async () => {
          const response = await params.runVisualModel({
            cfg: params.cfg,
            agentDir: params.agentDir,
            modelOverride: params.runtime.model,
            prompt,
            images: [...contextImages],
          });
          const decision = parseVisualDecisionFromText(response.text);
          return { response, decision };
        },
      });

      const rawText = modelResult.value.response.text.slice(0, MAX_DECISION_TEXT);
      const decision = modelResult.value.decision;
      trace.decision.attempts = modelResult.attempts;
      trace.decision.provider = modelResult.value.response.provider;
      trace.decision.model = modelResult.value.response.model;
      trace.decision.kind = decision.kind;
      trace.decision.reason = decision.reason;
      trace.decision.rawText = rawText;

      checkApprovalAction(params.runtime, decision);

      if (decision.kind === "done") {
        trace.outcome = "done";
        trace.finishedAt = params.now();
        trace.durationMs = trace.finishedAt - trace.startedAt;
        params.record.trace.push(trace);
        params.record.status = "completed";
        params.record.finishedAt = params.now();
        params.record.loopCount = loop;
        return;
      }

      if (params.settings.dryRun) {
        trace.execute = {
          attempts: 0,
          skipped: true,
          result: { dryRun: true },
        };
        trace.outcome = "executed";
      } else {
        const executed = await withRetries({
          label: "visual execute",
          retries: params.settings.retryExecute,
          task: async () => {
            if (params.settings.target === "browser") {
              return await executeBrowserDecision({
                executeBrowser: params.executeBrowser,
                decision,
                targetId: params.settings.targetId,
                profile: params.settings.profile,
                browserTarget: params.settings.browserTarget,
                node: params.settings.node,
              });
            }
            const node = params.settings.node?.trim();
            if (!node) {
              throw new Error("visual desktop target requires node");
            }
            return await executeDesktopDecision({
              executeNodes: params.executeNodes,
              node,
              decision,
            });
          },
        });
        trace.execute = {
          attempts: executed.attempts,
          result: executed.value,
        };
        trace.outcome = "executed";
      }
    } catch (err) {
      trace.outcome = "failed";
      trace.error = err instanceof Error ? err.message : String(err);
      params.record.status = "failed";
      params.record.error = trace.error;
      params.record.finishedAt = params.now();
    }

    trace.finishedAt = params.now();
    trace.durationMs = trace.finishedAt - trace.startedAt;
    params.record.trace.push(trace);
    params.record.loopCount = loop;

    if (params.record.status === "failed") {
      return;
    }
    if (loop >= params.settings.maxLoopCount) {
      params.record.status = "stopped";
      params.record.error = `maxLoopCount reached (${params.settings.maxLoopCount})`;
      params.record.finishedAt = params.now();
      return;
    }
    if (params.settings.loopIntervalInMs > 0) {
      await params.sleep(params.settings.loopIntervalInMs);
    }
  }
}

function summarizeRun(record: VisualRunRecord, includeTrace = false) {
  return {
    runId: record.runId,
    status: record.status,
    action: record.action,
    target: record.target,
    goal: record.goal,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    loopCount: record.loopCount,
    stopRequested: record.stopRequested,
    ...(record.error ? { error: record.error } : {}),
    ...(includeTrace ? { trace: record.trace } : {}),
  };
}

export function createVisualTool(
  options?: {
    config?: OpenClawConfig;
    agentSessionKey?: string;
    agentDir?: string;
    sandboxBridgeUrl?: string;
    allowHostControl?: boolean;
  },
  deps?: VisualToolDeps,
): AnyAgentTool | null {
  const runtime = resolveVisualConfig({
    cfg: options?.config,
    agentSessionKey: options?.agentSessionKey,
  });
  if (!runtime.enabled) {
    return null;
  }

  const imageModelConfig = coerceImageModelConfig(options?.config);
  const hasConfiguredImageModel =
    Boolean(runtime.model) ||
    Boolean(imageModelConfig.primary) ||
    (imageModelConfig.fallbacks?.length ?? 0) > 0;
  const explicitEnable = options?.config?.tools?.visual?.enabled === true;
  const agentExplicitEnable =
    (() => {
      const cfg = options?.config;
      if (!cfg) {
        return false;
      }
      const agentId = resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: cfg,
      });
      return resolveAgentConfig(cfg, agentId)?.tools?.visual?.enabled === true;
    })() ?? false;
  const forceEnable = explicitEnable || agentExplicitEnable;
  if (!forceEnable && !hasConfiguredImageModel) {
    return null;
  }
  if (!forceEnable && !options?.agentDir?.trim()) {
    return null;
  }

  const browserTool = createBrowserTool({
    sandboxBridgeUrl: options?.sandboxBridgeUrl,
    allowHostControl: options?.allowHostControl,
  });
  const nodesTool = createNodesTool({
    agentSessionKey: options?.agentSessionKey,
    config: options?.config,
  });

  const now = deps?.now ?? (() => Date.now());
  const sleep =
    deps?.sleep ??
    (async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  const runVisualModel = deps?.runVisualModel ?? runVisualModelDefault;
  const executeBrowser =
    deps?.executeBrowser ??
    (async (args: Record<string, unknown>) => {
      return await browserTool.execute(`visual-browser-${crypto.randomUUID()}`, args);
    });
  const executeNodes =
    deps?.executeNodes ??
    (async (args: Record<string, unknown>) => {
      return await nodesTool.execute(`visual-nodes-${crypto.randomUUID()}`, args);
    });
  const createRunId = deps?.createRunId ?? (() => crypto.randomUUID());

  return {
    label: "Visual",
    name: "visual",
    description:
      "Visual operator loop: capture screenshot/snapshot, let a vision model choose next action, then execute browser/desktop actions with bounded retries and traces.",
    parameters: VisualToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as VisualToolAction;

      if (action === "status") {
        const runId = readStringParam(params, "runId");
        if (runId) {
          const record = visualRuns.get(runId);
          if (!record) {
            throw new Error(`visual run not found: ${runId}`);
          }
          const includeTrace = params.includeTrace === true;
          return jsonResult(summarizeRun(record, includeTrace));
        }
        const runs = [...visualRuns.values()]
          .toSorted((a, b) => b.startedAt - a.startedAt)
          .slice(0, MAX_TRACE_RECORDS)
          .map((record) => summarizeRun(record, false));
        return jsonResult({ runs });
      }

      if (action === "stop") {
        const runId = readStringParam(params, "runId", { required: true });
        const record = visualRuns.get(runId);
        if (!record) {
          throw new Error(`visual run not found: ${runId}`);
        }
        record.stopRequested = true;
        if (record.status === "running") {
          record.status = "stopped";
          record.finishedAt = now();
          record.error = "stop requested";
        }
        return jsonResult(summarizeRun(record, true));
      }

      ensureImageUploadsEnabled(runtime);
      const defaultRunId = createRunId();
      let settings = resolveLoopSettings(
        {
          args: params,
          runtime,
        },
        defaultRunId,
      );
      ensureTargetAllowed(settings.target, runtime);
      settings = await ensureDesktopNode({ settings, executeNodes });

      const existing = visualRuns.get(settings.runId);
      if (existing?.status === "running") {
        throw new Error(`visual run already active: ${settings.runId}`);
      }
      const record: VisualRunRecord = {
        runId: settings.runId,
        status: "running",
        action: settings.action,
        target: settings.target,
        goal: settings.goal,
        startedAt: now(),
        loopCount: 0,
        trace: [],
        stopRequested: false,
      };
      visualRuns.set(record.runId, record);

      await runVisualLoop({
        runtime,
        settings,
        record,
        now,
        sleep,
        runVisualModel,
        executeBrowser,
        executeNodes,
        cfg: options?.config,
        agentDir: options?.agentDir,
      });

      if (!record.finishedAt) {
        record.finishedAt = now();
      }
      if (record.status === "running") {
        record.status = "completed";
      }
      trimRunsStore();
      return jsonResult(summarizeRun(record, settings.includeTrace));
    },
  };
}

export const __testing = {
  normalizeVisualAction,
  normalizeDecision,
  parseVisualDecisionFromText,
  buildVisualModelPrompt,
  extractJsonCandidate,
  summarizeTrace,
};
