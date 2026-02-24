import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { VisualToolsConfig } from "../../config/types.tools.js";
import { parseNodeList } from "../../shared/node-list-parse.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { resolveAgentConfig, resolveSessionAgentId } from "../agent-scope.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { createBrowserTool } from "./browser-tool.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { coerceImageModelConfig } from "./image-tool.helpers.js";
import { createNodesTool } from "./nodes-tool.js";
import { runVisualLoop, runVisualModelDefault } from "./visual-tool.loop.js";
import { buildVisualModelPrompt } from "./visual-tool.loop.js";
import {
  extractJsonCandidate,
  normalizeDecision,
  normalizeVisualAction,
  parseVisualDecisionFromText,
  readBoundedInt,
  summarizeTrace,
  trimToUndefined,
} from "./visual-tool.parse.js";
import type {
  VisualAction,
  VisualDecision,
  VisualLoopSettings,
  VisualRunRecord,
  VisualRuntimeConfig,
  VisualTarget,
  VisualToolAction,
  VisualToolDeps,
} from "./visual-tool.types.js";
import {
  DEFAULT_CONTEXT_MAX_IMAGES,
  DEFAULT_LOOP_INTERVAL_IN_MS,
  DEFAULT_MAX_LOOP_COUNT,
  DEFAULT_RETRY_EXECUTE,
  DEFAULT_RETRY_MODEL,
  DEFAULT_RETRY_SCREENSHOT,
  MAX_CONTEXT_MAX_IMAGES,
  MAX_LOOP_INTERVAL_IN_MS,
  MAX_MAX_LOOP_COUNT,
  MAX_TRACE_RECORDS,
  MIN_CONTEXT_MAX_IMAGES,
  MIN_MAX_LOOP_COUNT,
  VISUAL_BROWSER_TARGETS,
  VISUAL_SNAPSHOT_FORMATS,
  VISUAL_TARGETS,
  VISUAL_TOOL_ACTIONS,
} from "./visual-tool.types.js";

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
  executeNodes: (
    args: Record<string, unknown>,
  ) => Promise<import("@mariozechner/pi-agent-core").AgentToolResult<unknown>>;
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
      "Autonomous visual operator loop: captures screenshot, lets a vision model decide the next action, executes it, and repeats until the goal is visually confirmed on screen. Use action=run for full autonomous execution (preferred for desktop UI tasks). The loop verifies completion via screenshot before finishing.",
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
        checkApprovalAction,
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
