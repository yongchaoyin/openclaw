import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";

export const VISUAL_TOOL_ACTIONS = ["run", "step", "stop", "status"] as const;
export const VISUAL_TARGETS = ["browser", "desktop"] as const;
export const VISUAL_BROWSER_TARGETS = ["sandbox", "host", "node"] as const;
export const VISUAL_SNAPSHOT_FORMATS = ["png", "jpeg"] as const;
export const VISUAL_APPROVAL_ACTIONS = [
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

export const DEFAULT_MAX_LOOP_COUNT = 100;
export const MIN_MAX_LOOP_COUNT = 25;
export const MAX_MAX_LOOP_COUNT = 200;
export const DEFAULT_LOOP_INTERVAL_IN_MS = 1000;
export const MAX_LOOP_INTERVAL_IN_MS = 3000;
export const DEFAULT_CONTEXT_MAX_IMAGES = 5;
export const MIN_CONTEXT_MAX_IMAGES = 1;
export const MAX_CONTEXT_MAX_IMAGES = 10;
export const DEFAULT_RETRY_MODEL = 5;
export const DEFAULT_RETRY_SCREENSHOT = 5;
export const DEFAULT_RETRY_EXECUTE = 1;
export const MAX_TRACE_RECORDS = 30;
export const MAX_DECISION_TEXT = 8_000;
export const MAX_SNAPSHOT_TEXT = 12_000;
export const MAX_HISTORY_ITEMS = 12;
export const DEFAULT_BROWSER_REFS = "aria";
export const DEFAULT_BROWSER_SNAPSHOT_FORMAT = "ai";
export const MINIMAX_VISUAL_DEFAULT_MODEL = "minimax/MiniMax-VL-01";

export type VisualAction = (typeof VISUAL_APPROVAL_ACTIONS)[number];
export type VisualToolAction = (typeof VISUAL_TOOL_ACTIONS)[number];
export type VisualTarget = (typeof VISUAL_TARGETS)[number];

export type VisualImage = {
  base64: string;
  mimeType: string;
};

export type VisualObservation = {
  capturedAt: number;
  target: VisualTarget;
  image: VisualImage;
  snapshotText?: string;
  meta?: Record<string, unknown>;
};

export type VisualDecision = {
  kind: VisualAction;
  reason?: string;
  ref?: string;
  selector?: string;
  coordSpace?: "image" | "screen";
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

export type VisualModelResponse = {
  text: string;
  provider: string;
  model: string;
  attempts: Array<{ provider: string; model: string; error: string }>;
};

export type VisualLoopTrace = {
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

export type VisualRunRecord = {
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

export type VisualRuntimeConfig = {
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

export type VisualLoopSettings = {
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

export type VisualDecisionPromptInput = {
  target: VisualTarget;
  goal: string;
  loop: number;
  maxLoopCount: number;
  observation: VisualObservation;
  previousTrace: VisualLoopTrace[];
};

export type VisualToolDeps = {
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
