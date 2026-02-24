import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createVisualTool } from "./visual-tool.js";
import { buildVisualModelPrompt } from "./visual-tool.loop.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";

function snapshotResult(text = "snapshot"): AgentToolResult<unknown> {
  return {
    content: [
      { type: "text", text },
      { type: "image", data: PNG_B64, mimeType: "image/png" },
    ],
    details: { targetId: "tab-1", url: "https://example.com" },
  };
}

function jsonResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

function createTool(overrides?: {
  executeBrowser?: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
  executeNodes?: (args: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;
  runVisualModel?: (input: {
    prompt: string;
    images: Array<{ base64: string; mimeType: string }>;
  }) => Promise<{
    text: string;
    provider: string;
    model: string;
    attempts: Array<{ provider: string; model: string; error: string }>;
  }>;
}) {
  const tool = createVisualTool(
    {
      config: {
        tools: {
          visual: {
            enabled: true,
          },
        },
      },
      agentDir: "/tmp/agent",
    },
    {
      executeBrowser: overrides?.executeBrowser,
      executeNodes: overrides?.executeNodes,
      runVisualModel: overrides?.runVisualModel,
      sleep: vi.fn(async () => undefined),
      now: (() => {
        let ts = 1_000;
        return () => {
          ts += 10;
          return ts;
        };
      })(),
      createRunId: () => `run-${Date.now()}`,
    },
  );
  if (!tool) {
    throw new Error("visual tool not created");
  }
  return tool;
}

describe("buildVisualModelPrompt", () => {
  it("includes browser-specific rules for browser target", () => {
    const prompt = buildVisualModelPrompt({
      target: "browser",
      goal: "find the button",
      loop: 1,
      maxLoopCount: 50,
      observation: {
        capturedAt: 1000,
        target: "browser",
        image: { base64: "abc", mimeType: "image/png" },
        snapshotText: '[ref="e1"] button "Submit"',
      },
      previousTrace: [],
    });

    expect(prompt).toContain("visual operator");
    expect(prompt).toContain("navigate");
    expect(prompt).toContain("navigate_back");
    expect(prompt).toContain("find the button");
    expect(prompt).toContain("Loop: 1/50");
    expect(prompt).toContain("ref");
    expect(prompt).toContain("Latest snapshot text:");
    expect(prompt).toContain('[ref="e1"] button "Submit"');
  });

  it("includes desktop-specific rules for desktop target", () => {
    const prompt = buildVisualModelPrompt({
      target: "desktop",
      goal: "click system settings",
      loop: 3,
      maxLoopCount: 100,
      observation: {
        capturedAt: 1000,
        target: "desktop",
        image: { base64: "abc", mimeType: "image/png" },
        snapshotText: '[Button] "System Settings" (120, 45, 80, 24)',
        meta: { screenWidth: 1440, screenHeight: 900, scaleFactor: 2 },
      },
      previousTrace: [],
    });

    expect(prompt).toContain("screen coordinates");
    expect(prompt).toContain("x/y for clicks");
    expect(prompt).toContain("Screen logical size: 1440x900");
    expect(prompt).toContain("scale factor: 2x");
    expect(prompt).toContain("logical pixels");
    expect(prompt).toContain("accessibility API");
    expect(prompt).toContain("[ref=dN]");
    expect(prompt).toContain("click its exact center");
    expect(prompt).toContain("UI elements (accessibility tree):");
    expect(prompt).toContain('[Button] "System Settings" (120, 45, 80, 24)');
    // Desktop does not include navigate/navigate_back in allowed actions
    expect(prompt).not.toContain("navigate_back");
  });

  it("omits screen info when meta is missing", () => {
    const prompt = buildVisualModelPrompt({
      target: "desktop",
      goal: "test",
      loop: 1,
      maxLoopCount: 50,
      observation: {
        capturedAt: 1000,
        target: "desktop",
        image: { base64: "abc", mimeType: "image/png" },
      },
      previousTrace: [],
    });

    expect(prompt).not.toContain("Screen logical size:");
    expect(prompt).not.toContain("accessibility API");
    expect(prompt).toContain("(none)");
  });

  it("includes recent trace summary", () => {
    const prompt = buildVisualModelPrompt({
      target: "browser",
      goal: "test",
      loop: 3,
      maxLoopCount: 50,
      observation: {
        capturedAt: 1000,
        target: "browser",
        image: { base64: "abc", mimeType: "image/png" },
        snapshotText: "some text",
      },
      previousTrace: [
        {
          loop: 1,
          startedAt: 800,
          finishedAt: 850,
          durationMs: 50,
          observe: {
            attempts: 1,
            target: "browser",
            snapshotTextChars: 10,
            imageMimeType: "image/png",
            capturedAt: 800,
          },
          decision: {
            attempts: 1,
            provider: "openai",
            model: "gpt-5-mini",
            kind: "click",
            rawText: "",
          },
          outcome: "executed",
        },
      ],
    });

    expect(prompt).toContain("Recent actions: #1 click (executed)");
  });
});

describe("visual tool integration", () => {
  it("step mode runs exactly one loop", async () => {
    const executeBrowser = vi.fn(async () => snapshotResult("step snapshot"));
    const runVisualModel = vi.fn(async () => ({
      text: JSON.stringify({ kind: "click", ref: "e1" }),
      provider: "openai",
      model: "gpt-5-mini",
      attempts: [],
    }));
    const tool = createTool({ executeBrowser, runVisualModel });

    const result = await tool.execute("step-1", {
      action: "step",
      target: "browser",
      goal: "single step test",
    });
    const details = result.details as { status: string; loopCount: number };

    // Step mode should stop after 1 loop even if model didn't return "done"
    expect(details.loopCount).toBe(1);
    expect(details.status).toBe("stopped");
    expect(runVisualModel).toHaveBeenCalledTimes(1);
  });

  it("dryRun skips execution", async () => {
    const executeBrowser = vi.fn(async (args: Record<string, unknown>) => {
      if (args.action === "snapshot") {
        return snapshotResult("dry run snapshot");
      }
      // Act should NOT be called in dryRun mode
      throw new Error("should not execute actions in dry run");
    });
    let calls = 0;
    const runVisualModel = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: JSON.stringify({ kind: "click", ref: "e5" }),
          provider: "openai",
          model: "gpt-5-mini",
          attempts: [],
        };
      }
      return {
        text: JSON.stringify({ kind: "done" }),
        provider: "openai",
        model: "gpt-5-mini",
        attempts: [],
      };
    });
    const tool = createTool({ executeBrowser, runVisualModel });

    const result = await tool.execute("dry-1", {
      action: "run",
      target: "browser",
      goal: "dry run test",
      dryRun: true,
    });
    const details = result.details as {
      status: string;
      trace: Array<{ execute?: { skipped?: boolean } }>;
    };

    expect(details.status).toBe("completed");
    expect(details.trace[0]?.execute?.skipped).toBe(true);
  });

  it("status action returns run list", async () => {
    const tool = createTool({
      executeBrowser: vi.fn(async () => snapshotResult()),
      runVisualModel: vi.fn(async () => ({
        text: JSON.stringify({ kind: "done" }),
        provider: "openai",
        model: "gpt-5-mini",
        attempts: [],
      })),
    });

    // First create a run
    await tool.execute("create-1", {
      action: "run",
      target: "browser",
      goal: "status test",
    });

    // Then query status
    const result = await tool.execute("status-1", { action: "status" });
    const details = result.details as { runs: Array<{ goal: string }> };

    expect(details.runs).toBeDefined();
    expect(details.runs.length).toBeGreaterThan(0);
  });

  it("desktop mode passes node to desktop_snapshot", async () => {
    const executeNodes = vi.fn(async (args: Record<string, unknown>) => {
      if (args.action === "status") {
        return jsonResult({
          nodes: [
            {
              nodeId: "mac-local",
              displayName: "Local Mac",
              connected: true,
              caps: ["desktop"],
              commands: ["desktop.snapshot", "desktop.act"],
            },
          ],
        });
      }
      if (args.action === "desktop_snapshot") {
        expect(args.node).toBe("mac-local");
        return {
          content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }],
          details: {
            width: 1440,
            height: 900,
            screenWidth: 1440,
            screenHeight: 900,
            scaleFactor: 2,
          },
        };
      }
      if (args.action === "desktop_accessibility_snapshot") {
        return jsonResult({ ok: true, elements: [], text: "" });
      }
      if (args.action === "desktop_act") {
        return jsonResult({ ok: true });
      }
      throw new Error(`unexpected action: ${String(args.action)}`);
    });
    const promptTexts: string[] = [];
    const runVisualModel = vi.fn(async (input: { prompt: string }) => {
      promptTexts.push(input.prompt);
      return {
        text: JSON.stringify({ kind: "done" }),
        provider: "openai",
        model: "gpt-5-mini",
        attempts: [],
      };
    });
    const tool = createTool({ executeNodes, runVisualModel });

    const result = await tool.execute("desktop-1", {
      action: "run",
      target: "desktop",
      goal: "open settings",
    });
    const details = result.details as { status: string };

    expect(details.status).toBe("completed");
    // Verify the prompt included desktop-specific information
    expect(promptTexts[0]).toContain("screen coordinates");
    expect(promptTexts[0]).toContain("Screen logical size: 1440x900");
  });

  it("rejects disabled targets", async () => {
    const tool = createVisualTool(
      {
        config: {
          tools: {
            visual: {
              enabled: true,
              targets: { desktop: false },
            },
          },
        },
        agentDir: "/tmp/agent",
      },
      {
        executeBrowser: vi.fn(),
        executeNodes: vi.fn(),
        runVisualModel: vi.fn(),
        sleep: vi.fn(async () => undefined),
        now: () => Date.now(),
        createRunId: () => "run-x",
      },
    );

    await expect(
      tool!.execute("blocked-1", {
        action: "run",
        target: "desktop",
        goal: "should fail",
      }),
    ).rejects.toThrow("desktop is disabled");
  });

  it("rejects screenshot upload when policy is none", async () => {
    const tool = createVisualTool(
      {
        config: {
          tools: {
            visual: {
              enabled: true,
              data: { screenshotUploadPolicy: "none" },
            },
          },
        },
        agentDir: "/tmp/agent",
      },
      {
        executeBrowser: vi.fn(),
        executeNodes: vi.fn(),
        runVisualModel: vi.fn(),
        sleep: vi.fn(async () => undefined),
        now: () => Date.now(),
        createRunId: () => "run-x",
      },
    );

    await expect(
      tool!.execute("blocked-2", {
        action: "run",
        target: "browser",
        goal: "should fail",
      }),
    ).rejects.toThrow("screenshotUploadPolicy=none");
  });

  it("approval action blocks execution", async () => {
    const tool = createVisualTool(
      {
        config: {
          tools: {
            visual: {
              enabled: true,
              safety: { requireApprovalActions: ["click"] },
            },
          },
        },
        agentDir: "/tmp/agent",
      },
      {
        executeBrowser: vi.fn(async () => snapshotResult()),
        executeNodes: vi.fn(),
        runVisualModel: vi.fn(async () => ({
          text: JSON.stringify({ kind: "click", ref: "e1" }),
          provider: "openai",
          model: "gpt-5-mini",
          attempts: [],
        })),
        sleep: vi.fn(async () => undefined),
        now: (() => {
          let ts = 1_000;
          return () => {
            ts += 10;
            return ts;
          };
        })(),
        createRunId: () => "run-approval",
      },
    );

    const result = await tool!.execute("approval-1", {
      action: "run",
      target: "browser",
      goal: "approval test",
      retryModel: 0,
    });
    const details = result.details as { status: string; error: string };

    expect(details.status).toBe("failed");
    expect(details.error).toContain("requires approval");
  });
});
