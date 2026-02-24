import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createVisualTool } from "./visual-tool.js";

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
      createRunId: () => "run-fixed",
    },
  );
  if (!tool) {
    throw new Error("visual tool not created");
  }
  return tool;
}

describe("visual tool", () => {
  it("completes when the model returns done", async () => {
    const executeBrowser = vi.fn(async () => snapshotResult("first snapshot"));
    const runVisualModel = vi.fn(async () => ({
      text: JSON.stringify({ kind: "done", reason: "task complete" }),
      provider: "openai",
      model: "gpt-5-mini",
      attempts: [],
    }));
    const tool = createTool({ executeBrowser, runVisualModel });

    const result = await tool.execute("call-1", {
      action: "run",
      target: "browser",
      goal: "finish quickly",
    });
    const details = result.details as {
      status: string;
      loopCount: number;
      trace: Array<{ decision: { kind: string }; outcome: string }>;
    };

    expect(details.status).toBe("completed");
    expect(details.loopCount).toBe(1);
    expect(details.trace).toHaveLength(1);
    expect(details.trace[0]?.decision.kind).toBe("done");
    expect(details.trace[0]?.outcome).toBe("done");
    expect(executeBrowser).toHaveBeenCalledTimes(1);
  });

  it("executes browser click and then finishes", async () => {
    const executeBrowser = vi.fn(async (args: Record<string, unknown>) => {
      if (args.action === "snapshot") {
        return snapshotResult("snapshot with refs");
      }
      if (args.action === "act") {
        const request = args.request as { kind?: string; ref?: string };
        expect(request.kind).toBe("click");
        expect(request.ref).toBe("e12");
        return jsonResult({ ok: true });
      }
      throw new Error(`unexpected browser action: ${String(args.action)}`);
    });

    let step = 0;
    const runVisualModel = vi.fn(async () => {
      step += 1;
      if (step === 1) {
        return {
          text: JSON.stringify({ kind: "click", ref: "e12", reason: "open menu" }),
          provider: "openai",
          model: "gpt-5-mini",
          attempts: [],
        };
      }
      return {
        text: JSON.stringify({ kind: "done", reason: "done now" }),
        provider: "openai",
        model: "gpt-5-mini",
        attempts: [],
      };
    });
    const tool = createTool({ executeBrowser, runVisualModel });

    const result = await tool.execute("call-2", {
      action: "run",
      target: "browser",
      goal: "click once then stop",
    });
    const details = result.details as {
      status: string;
      loopCount: number;
      trace: Array<{ decision: { kind: string }; outcome: string }>;
    };

    expect(details.status).toBe("completed");
    expect(details.loopCount).toBe(2);
    expect(details.trace[0]?.decision.kind).toBe("click");
    expect(details.trace[0]?.outcome).toBe("executed");
    expect(details.trace[1]?.decision.kind).toBe("done");
  });

  it("retries model decision failures", async () => {
    const executeBrowser = vi.fn(async () => snapshotResult("retry snapshot"));
    let calls = 0;
    const runVisualModel = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("temporary model error");
      }
      return {
        text: JSON.stringify({ kind: "done" }),
        provider: "openai",
        model: "gpt-5-mini",
        attempts: [],
      };
    });
    const tool = createTool({ executeBrowser, runVisualModel });

    const result = await tool.execute("call-3", {
      action: "run",
      target: "browser",
      goal: "retry test",
      retryModel: 1,
    });
    const details = result.details as {
      status: string;
      trace: Array<{ decision: { attempts: number } }>;
    };

    expect(details.status).toBe("completed");
    expect(details.trace[0]?.decision.attempts).toBe(2);
  });

  it("caps model image context window", async () => {
    const executeBrowser = vi.fn(async (args: Record<string, unknown>) => {
      if (args.action === "snapshot") {
        return snapshotResult("window snapshot");
      }
      if (args.action === "act") {
        return jsonResult({ ok: true });
      }
      throw new Error(`unexpected browser action: ${String(args.action)}`);
    });
    const imageCounts: number[] = [];
    let loop = 0;
    const runVisualModel = vi.fn(async (input: { images: unknown[] }) => {
      imageCounts.push(input.images.length);
      loop += 1;
      if (loop < 3) {
        return {
          text: JSON.stringify({ kind: "wait", ms: 10 }),
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

    await tool.execute("call-4", {
      action: "run",
      target: "browser",
      goal: "context cap test",
      contextMaxImages: 2,
    });

    expect(imageCounts).toEqual([1, 2, 2]);
  });

  it("auto-selects a connected desktop node when missing", async () => {
    const executeNodes = vi.fn(async (args: Record<string, unknown>) => {
      if (args.action === "status") {
        return jsonResult({
          nodes: [
            {
              nodeId: "mac-001",
              displayName: "My Mac",
              connected: true,
              caps: ["desktop"],
            },
          ],
        });
      }
      if (args.action === "desktop_snapshot") {
        return snapshotResult("desktop snapshot");
      }
      if (args.action === "desktop_act") {
        return jsonResult({ ok: true });
      }
      throw new Error(`unexpected nodes action: ${String(args.action)}`);
    });
    const runVisualModel = vi.fn(async () => ({
      text: JSON.stringify({ kind: "done" }),
      provider: "openai",
      model: "gpt-5-mini",
      attempts: [],
    }));
    const tool = createTool({ executeNodes, runVisualModel });

    const result = await tool.execute("call-5", {
      action: "run",
      target: "desktop",
      goal: "desktop without node",
    });

    expect((result.details as { status: string }).status).toBe("completed");
    expect(executeNodes).toHaveBeenCalledWith(expect.objectContaining({ action: "status" }));
    expect(executeNodes).toHaveBeenCalledWith(
      expect.objectContaining({ action: "desktop_snapshot", node: "mac-001" }),
    );
  });

  it("errors with candidate list when desktop node is missing", async () => {
    const executeNodes = vi.fn(async (args: Record<string, unknown>) => {
      if (args.action === "status") {
        return jsonResult({
          nodes: [
            {
              nodeId: "mac-001",
              displayName: "My Mac",
              connected: false,
              caps: ["desktop"],
            },
            {
              nodeId: "mac-002",
              displayName: "Backup Mac",
              connected: false,
              caps: ["desktop"],
            },
          ],
        });
      }
      throw new Error(`unexpected nodes action: ${String(args.action)}`);
    });
    const tool = createTool({
      executeNodes,
      runVisualModel: vi.fn(async () => ({
        text: JSON.stringify({ kind: "done" }),
        provider: "openai",
        model: "gpt-5-mini",
        attempts: [],
      })),
    });

    await expect(
      tool.execute("call-6", {
        action: "run",
        target: "desktop",
        goal: "desktop without node",
      }),
    ).rejects.toThrow("visual desktop target requires node (available nodes:");
  });
});
