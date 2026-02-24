import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Api, type Context, complete, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { minimaxUnderstandImage } from "../minimax-vlm.js";
import { getApiKeyForModel, requireApiKey } from "../model-auth.js";
import { runWithImageModelFallback } from "../model-fallback.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import { coerceImageAssistantText, coerceImageModelConfig } from "./image-tool.helpers.js";
import { executeBrowserDecision } from "./visual-tool.execute.js";
import { executeDesktopDecision } from "./visual-tool.execute.js";
import { observeBrowser } from "./visual-tool.observe.js";
import { observeDesktop } from "./visual-tool.observe.js";
import { parseVisualDecisionFromText, summarizeTrace } from "./visual-tool.parse.js";
import type {
  VisualDecision,
  VisualDecisionPromptInput,
  VisualImage,
  VisualLoopSettings,
  VisualLoopTrace,
  VisualModelResponse,
  VisualRunRecord,
  VisualRuntimeConfig,
  VisualObservation,
} from "./visual-tool.types.js";
import {
  MAX_DECISION_TEXT,
  MAX_SNAPSHOT_TEXT,
  MINIMAX_VISUAL_DEFAULT_MODEL,
} from "./visual-tool.types.js";

export function buildVisualModelPrompt(input: VisualDecisionPromptInput): string {
  const allowed =
    input.target === "browser"
      ? "click, doubleClick, rightClick, move, drag, type, hotkey, scroll, wait, navigate, navigate_back, done"
      : "click, doubleClick, rightClick, move, drag, type, hotkey, scroll, wait, done";
  const snapshotText = (input.observation.snapshotText ?? "").slice(0, MAX_SNAPSHOT_TEXT);
  const recentTrace = summarizeTrace(input.previousTrace);
  const sharedRules = [
    "You are a visual operator that autonomously completes tasks via screenshot → action loops.",
    "Decide the next SINGLE action needed to progress toward the goal.",
    "Return ONLY a JSON object. No markdown, no prose.",
    `Allowed kinds: ${allowed}.`,
    "IMPORTANT: Only return kind=done AFTER you have visually confirmed the goal is achieved in the CURRENT screenshot.",
    "Do NOT return done right after performing an action — wait at least one more loop to verify the result on screen.",
    "If you just performed an action (e.g., opened an app), use kind=wait (ms=1000) first, then verify in the next loop.",
    "Never invent unsupported actions.",
  ];

  const meta = input.observation.meta ?? {};
  const desktopRules: string[] = [];
  if (input.target !== "browser") {
    desktopRules.push(
      "Desktop actions rely on screen coordinates (logical pixels).",
      "Use x/y for clicks and move; fromX/fromY/toX/toY for drag.",
      'Set coordSpace="screen" when using accessibility bounds.',
      'Set coordSpace="image" when estimating from the screenshot; the runtime will map image pixels to screen coordinates.',
    );
    // Include screen resolution info when available so the VLM can reason about coordinates
    const screenW = typeof meta.screenWidth === "number" ? meta.screenWidth : undefined;
    const screenH = typeof meta.screenHeight === "number" ? meta.screenHeight : undefined;
    const scale = typeof meta.scaleFactor === "number" ? meta.scaleFactor : undefined;
    const imageW = typeof meta.width === "number" ? meta.width : undefined;
    const imageH = typeof meta.height === "number" ? meta.height : undefined;
    if (imageW && imageH) {
      desktopRules.push(`Screenshot pixel size: ${imageW}x${imageH}.`);
    }
    if (screenW && screenH) {
      desktopRules.push(
        `Screen logical size: ${screenW}x${screenH}${scale ? ` (scale factor: ${scale}x)` : ""}.`,
      );
    }
    if (snapshotText) {
      desktopRules.push(
        "A UI element tree from the accessibility API is provided below.",
        'Each element shows [role] "label" (x, y, width, height).',
        "When an element matches your target, use the center of its bounds as coordinates.",
        "When no matching element exists, estimate coordinates from the screenshot.",
      );
    }
  }

  const browserRules =
    input.target === "browser"
      ? [
          "Prefer using ref from the latest browser snapshot for interactions.",
          "Use navigate only for URL changes.",
          "Use navigate_back for browser back navigation.",
        ]
      : desktopRules;

  return [
    ...sharedRules,
    ...browserRules,
    "",
    `Goal: ${input.goal}`,
    `Loop: ${input.loop}/${input.maxLoopCount}`,
    `Recent actions: ${recentTrace}`,
    "",
    input.target === "browser" ? "Latest snapshot text:" : "UI elements (accessibility tree):",
    snapshotText || "(none)",
    "",
    "JSON schema:",
    `{"kind":"<allowed>","reason":"<short reason>","coordSpace":"image|screen","ref":"<optional>","selector":"<optional>","x":0,"y":0,"fromX":0,"fromY":0,"toX":0,"toY":0,"startRef":"<optional>","endRef":"<optional>","text":"<optional>","keys":["<optional>"],"deltaX":0,"deltaY":0,"ms":250,"button":"left|right|middle","url":"https://..."}`,
  ].join("\n");
}

function scaleCoord(value: number | undefined, scale: number, max?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return value;
  }
  const scaled = value * scale;
  if (typeof max === "number" && Number.isFinite(max)) {
    const clamped = Math.min(Math.max(0, scaled), Math.max(0, max - 1));
    return clamped;
  }
  return scaled;
}

function normalizeDesktopDecisionForExecution(
  decision: VisualDecision,
  observation: VisualObservation,
): VisualDecision {
  if (
    decision.kind === "navigate" ||
    decision.kind === "navigate_back" ||
    decision.kind === "scroll" ||
    decision.kind === "hotkey" ||
    decision.kind === "type" ||
    decision.kind === "wait" ||
    decision.kind === "done"
  ) {
    return decision;
  }

  const meta = observation.meta ?? {};
  const imageW = typeof meta.width === "number" ? meta.width : undefined;
  const imageH = typeof meta.height === "number" ? meta.height : undefined;
  const screenW = typeof meta.screenWidth === "number" ? meta.screenWidth : undefined;
  const screenH = typeof meta.screenHeight === "number" ? meta.screenHeight : undefined;

  if (!imageW || !imageH || !screenW || !screenH) {
    return decision;
  }
  if (decision.coordSpace === "screen") {
    return decision;
  }

  const scaleX = screenW / imageW;
  const scaleY = screenH / imageH;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) {
    return decision;
  }
  if (Math.abs(scaleX - 1) < 0.001 && Math.abs(scaleY - 1) < 0.001) {
    return decision;
  }

  // Heuristic: when imageW < screenW (e.g. user set a small maxWidth), the VLM may
  // have taken coordinates directly from the accessibility tree (screen space) instead
  // of estimating from the image. Detect this by checking if any coordinate exceeds
  // the image bounds but still falls within screen bounds — if so, treat as screen coords.
  if (imageW < screenW || imageH < screenH) {
    const coordPairs: [number | undefined, number, number][] = [
      [decision.x, imageW, screenW],
      [decision.y, imageH, screenH],
      [decision.fromX, imageW, screenW],
      [decision.fromY, imageH, screenH],
      [decision.toX, imageW, screenW],
      [decision.toY, imageH, screenH],
    ];
    const hasCoordBeyondImage = coordPairs.some(
      ([v, imgMax, _scrMax]) => typeof v === "number" && v > imgMax,
    );
    const allCoordsWithinScreen = coordPairs.every(
      ([v, _imgMax, scrMax]) => typeof v !== "number" || (v >= 0 && v <= scrMax),
    );
    if (hasCoordBeyondImage && allCoordsWithinScreen) {
      return { ...decision, coordSpace: "screen" };
    }
  }

  return {
    ...decision,
    coordSpace: "screen",
    x: scaleCoord(decision.x, scaleX, screenW),
    y: scaleCoord(decision.y, scaleY, screenH),
    fromX: scaleCoord(decision.fromX, scaleX, screenW),
    fromY: scaleCoord(decision.fromY, scaleY, screenH),
    toX: scaleCoord(decision.toX, scaleX, screenW),
    toY: scaleCoord(decision.toY, scaleY, screenH),
  };
}

export async function runVisualModelDefault(input: {
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

export async function withRetries<T>(params: {
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

export async function runVisualLoop(params: {
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
  checkApprovalAction: (runtime: VisualRuntimeConfig, decision: VisualDecision) => void;
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

      params.checkApprovalAction(params.runtime, decision);

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
        const decisionForExecution =
          params.settings.target === "desktop"
            ? normalizeDesktopDecisionForExecution(decision, observed.value)
            : decision;
        const executed = await withRetries({
          label: "visual execute",
          retries: params.settings.retryExecute,
          task: async () => {
            if (params.settings.target === "browser") {
              return await executeBrowserDecision({
                executeBrowser: params.executeBrowser,
                decision: decisionForExecution,
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
              decision: decisionForExecution,
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
