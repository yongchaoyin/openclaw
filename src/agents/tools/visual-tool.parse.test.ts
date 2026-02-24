import { describe, expect, it } from "vitest";
import {
  asFiniteInteger,
  extractJsonCandidate,
  extractToolImage,
  extractToolText,
  normalizeButton,
  normalizeDecision,
  normalizeVisualAction,
  parseVisualDecisionFromText,
  readBoundedInt,
  summarizeTrace,
  trimToUndefined,
} from "./visual-tool.parse.js";

describe("normalizeVisualAction", () => {
  it("normalizes standard action names", () => {
    expect(normalizeVisualAction("click")).toBe("click");
    expect(normalizeVisualAction("move")).toBe("move");
    expect(normalizeVisualAction("drag")).toBe("drag");
    expect(normalizeVisualAction("type")).toBe("type");
    expect(normalizeVisualAction("hotkey")).toBe("hotkey");
    expect(normalizeVisualAction("scroll")).toBe("scroll");
    expect(normalizeVisualAction("wait")).toBe("wait");
    expect(normalizeVisualAction("navigate")).toBe("navigate");
    expect(normalizeVisualAction("done")).toBe("done");
  });

  it("normalizes aliases", () => {
    expect(normalizeVisualAction("doubleClick")).toBe("doubleClick");
    expect(normalizeVisualAction("double_click")).toBe("doubleClick");
    expect(normalizeVisualAction("DOUBLECLICK")).toBe("doubleClick");
    expect(normalizeVisualAction("rightClick")).toBe("rightClick");
    expect(normalizeVisualAction("right_click")).toBe("rightClick");
    expect(normalizeVisualAction("navigate_back")).toBe("navigate_back");
    expect(normalizeVisualAction("navigateback")).toBe("navigate_back");
    expect(normalizeVisualAction("back")).toBe("navigate_back");
    expect(normalizeVisualAction("finish")).toBe("done");
    expect(normalizeVisualAction("finished")).toBe("done");
  });

  it("handles whitespace and mixed case", () => {
    expect(normalizeVisualAction("  Click  ")).toBe("click");
    expect(normalizeVisualAction("NAVIGATE_BACK")).toBe("navigate_back");
    expect(normalizeVisualAction("Double Click")).toBe("doubleClick");
  });

  it("returns null for unknown actions", () => {
    expect(normalizeVisualAction("unknown")).toBeNull();
    expect(normalizeVisualAction("")).toBeNull();
    expect(normalizeVisualAction("   ")).toBeNull();
    expect(normalizeVisualAction("fly")).toBeNull();
  });
});

describe("normalizeButton", () => {
  it("normalizes valid button values", () => {
    expect(normalizeButton("left")).toBe("left");
    expect(normalizeButton("right")).toBe("right");
    expect(normalizeButton("middle")).toBe("middle");
    expect(normalizeButton("LEFT")).toBe("left");
    expect(normalizeButton("  Right  ")).toBe("right");
  });

  it("returns undefined for invalid values", () => {
    expect(normalizeButton("")).toBeUndefined();
    expect(normalizeButton(undefined)).toBeUndefined();
    expect(normalizeButton(null)).toBeUndefined();
    expect(normalizeButton(42)).toBeUndefined();
    expect(normalizeButton("center")).toBeUndefined();
  });
});

describe("normalizeDecision", () => {
  it("normalizes a basic click decision", () => {
    const result = normalizeDecision({ kind: "click", ref: "e12", x: 100, y: 200 });
    expect(result.kind).toBe("click");
    expect(result.ref).toBe("e12");
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
  });

  it("accepts action or type as alternative to kind", () => {
    const fromAction = normalizeDecision({ action: "click", ref: "e1" });
    expect(fromAction.kind).toBe("click");

    const fromType = normalizeDecision({ type: "scroll", deltaY: 100 });
    expect(fromType.kind).toBe("scroll");
    expect(fromType.deltaY).toBe(100);
  });

  it("extracts ref from nested target object", () => {
    const result = normalizeDecision({ kind: "click", target: { ref: "nested-ref" } });
    expect(result.ref).toBe("nested-ref");
  });

  it("extracts coordinates from nested target object", () => {
    const result = normalizeDecision({ kind: "click", target: { x: 50, y: 75 } });
    expect(result.x).toBe(50);
    expect(result.y).toBe(75);
  });

  it("normalizes keys for hotkey", () => {
    const result = normalizeDecision({ kind: "hotkey", keys: ["cmd", "c"] });
    expect(result.keys).toEqual(["cmd", "c"]);
  });

  it("filters empty keys", () => {
    const result = normalizeDecision({ kind: "hotkey", keys: ["cmd", "", "  ", "v"] });
    expect(result.keys).toEqual(["cmd", "v"]);
  });

  it("accepts waitMs as alias for ms", () => {
    const result = normalizeDecision({ kind: "wait", waitMs: 500 });
    expect(result.ms).toBe(500);
  });

  it("accepts targetUrl as alias for url", () => {
    const result = normalizeDecision({ kind: "navigate", targetUrl: "https://example.com" });
    expect(result.url).toBe("https://example.com");
  });

  it("normalizes button field", () => {
    const result = normalizeDecision({ kind: "click", ref: "e1", button: "right" });
    expect(result.button).toBe("right");
  });

  it("throws for unsupported action kind", () => {
    expect(() => normalizeDecision({ kind: "fly" })).toThrow("unsupported action kind");
    expect(() => normalizeDecision({})).toThrow("unsupported action kind");
    expect(() => normalizeDecision({ kind: "" })).toThrow("unsupported action kind");
  });

  it("ignores non-finite numbers", () => {
    const result = normalizeDecision({ kind: "click", ref: "e1", x: NaN, y: Infinity });
    expect(result.x).toBeUndefined();
    expect(result.y).toBeUndefined();
  });
});

describe("extractJsonCandidate", () => {
  it("returns JSON when text is pure JSON", () => {
    const json = '{"kind":"click"}';
    expect(extractJsonCandidate(json)).toBe(json);
  });

  it("extracts JSON from markdown fence", () => {
    const text = '```json\n{"kind":"done"}\n```';
    expect(extractJsonCandidate(text)).toBe('{"kind":"done"}');
  });

  it("extracts JSON from fence without language tag", () => {
    const text = '```\n{"kind":"wait"}\n```';
    expect(extractJsonCandidate(text)).toBe('{"kind":"wait"}');
  });

  it("extracts JSON embedded in prose", () => {
    const text = 'I will click the button: {"kind":"click","ref":"e1"} and then stop.';
    expect(extractJsonCandidate(text)).toBe('{"kind":"click","ref":"e1"}');
  });

  it("handles nested braces", () => {
    const text = 'Some text {"kind":"click","target":{"ref":"e5"}} more text';
    expect(extractJsonCandidate(text)).toBe('{"kind":"click","target":{"ref":"e5"}}');
  });

  it("handles strings with braces inside", () => {
    const text = '{"kind":"type","text":"use { and } in code"}';
    expect(extractJsonCandidate(text)).toBe('{"kind":"type","text":"use { and } in code"}');
  });

  it("returns null for empty input", () => {
    expect(extractJsonCandidate("")).toBeNull();
    expect(extractJsonCandidate("   ")).toBeNull();
  });

  it("returns null when no JSON found", () => {
    expect(extractJsonCandidate("no json here")).toBeNull();
    expect(extractJsonCandidate("just some text")).toBeNull();
  });

  it("handles escaped quotes in strings", () => {
    const text = '{"kind":"type","text":"say \\"hello\\""}';
    expect(extractJsonCandidate(text)).toBe(text);
  });
});

describe("parseVisualDecisionFromText", () => {
  it("parses valid JSON into a decision", () => {
    const text = '{"kind":"click","ref":"e12","reason":"open menu"}';
    const decision = parseVisualDecisionFromText(text);
    expect(decision.kind).toBe("click");
    expect(decision.ref).toBe("e12");
    expect(decision.reason).toBe("open menu");
  });

  it("parses JSON wrapped in markdown", () => {
    const text = 'Here is my action:\n```json\n{"kind":"done","reason":"finished"}\n```';
    const decision = parseVisualDecisionFromText(text);
    expect(decision.kind).toBe("done");
    expect(decision.reason).toBe("finished");
  });

  it("throws for non-JSON text", () => {
    expect(() => parseVisualDecisionFromText("no json")).toThrow("did not return JSON");
  });

  it("throws for invalid JSON", () => {
    expect(() => parseVisualDecisionFromText("{invalid json}")).toThrow("invalid JSON");
  });

  it("throws for valid JSON with unsupported kind", () => {
    expect(() => parseVisualDecisionFromText('{"kind":"fly"}')).toThrow("unsupported action kind");
  });
});

describe("extractToolText", () => {
  it("extracts text blocks from content", () => {
    const result = extractToolText({
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
      details: {},
    });
    expect(result).toBe("hello\nworld");
  });

  it("ignores non-text blocks", () => {
    const result = extractToolText({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "base64data" },
      ],
      details: {},
    });
    expect(result).toBe("hello");
  });

  it("returns empty for no text content", () => {
    const result = extractToolText({
      content: [{ type: "image", data: "base64data" }],
      details: {},
    });
    expect(result).toBe("");
  });

  it("handles empty or missing content", () => {
    expect(extractToolText({ content: [], details: {} })).toBe("");
    expect(extractToolText({ details: {} } as ReturnType<typeof extractToolText>)).toBe("");
  });
});

describe("extractToolImage", () => {
  it("extracts image from content", () => {
    const image = extractToolImage({
      content: [{ type: "image", data: "abc123", mimeType: "image/png" }],
      details: {},
    });
    expect(image).toEqual({ base64: "abc123", mimeType: "image/png" });
  });

  it("defaults mimeType to image/png", () => {
    const image = extractToolImage({
      content: [{ type: "image", data: "abc123" }],
      details: {},
    });
    expect(image?.mimeType).toBe("image/png");
  });

  it("returns first image when multiple exist", () => {
    const image = extractToolImage({
      content: [
        { type: "image", data: "first", mimeType: "image/png" },
        { type: "image", data: "second", mimeType: "image/jpeg" },
      ],
      details: {},
    });
    expect(image?.base64).toBe("first");
  });

  it("returns null when no image in content", () => {
    const image = extractToolImage({
      content: [{ type: "text", text: "no image" }],
      details: {},
    });
    expect(image).toBeNull();
  });

  it("skips images with empty data", () => {
    const image = extractToolImage({
      content: [
        { type: "image", data: "", mimeType: "image/png" },
        { type: "image", data: "   ", mimeType: "image/png" },
      ],
      details: {},
    });
    expect(image).toBeNull();
  });
});

describe("summarizeTrace", () => {
  it("returns 'none' for empty trace", () => {
    expect(summarizeTrace([])).toBe("none");
  });

  it("summarizes single trace entry", () => {
    const trace = [
      {
        loop: 1,
        startedAt: 1000,
        finishedAt: 1100,
        durationMs: 100,
        observe: {
          attempts: 1,
          target: "browser" as const,
          snapshotTextChars: 50,
          imageMimeType: "image/png",
          capturedAt: 1000,
        },
        decision: {
          attempts: 1,
          provider: "openai",
          model: "gpt-5-mini",
          kind: "click" as const,
          rawText: "",
        },
        outcome: "executed" as const,
      },
    ];
    expect(summarizeTrace(trace)).toBe("#1 click (executed)");
  });

  it("includes error in summary", () => {
    const trace = [
      {
        loop: 1,
        startedAt: 1000,
        finishedAt: 1100,
        durationMs: 100,
        observe: {
          attempts: 1,
          target: "browser" as const,
          snapshotTextChars: 0,
          imageMimeType: "image/png",
          capturedAt: 1000,
        },
        decision: {
          attempts: 1,
          provider: "openai",
          model: "gpt-5-mini",
          kind: "click" as const,
          rawText: "",
        },
        outcome: "failed" as const,
        error: "something broke",
      },
    ];
    expect(summarizeTrace(trace)).toBe("#1 click (failed) err=something broke");
  });

  it("truncates to max history items", () => {
    const trace = Array.from({ length: 20 }, (_, i) => ({
      loop: i + 1,
      startedAt: 1000 + i * 100,
      finishedAt: 1000 + (i + 1) * 100,
      durationMs: 100,
      observe: {
        attempts: 1,
        target: "browser" as const,
        snapshotTextChars: 0,
        imageMimeType: "image/png",
        capturedAt: 1000 + i * 100,
      },
      decision: {
        attempts: 1,
        provider: "openai",
        model: "gpt-5-mini",
        kind: "wait" as const,
        rawText: "",
      },
      outcome: "executed" as const,
    }));
    const result = summarizeTrace(trace);
    // MAX_HISTORY_ITEMS is 12, so should only have entries 9-20
    const entries = result.split("; ");
    expect(entries).toHaveLength(12);
    expect(entries[0]).toContain("#9");
    expect(entries[11]).toContain("#20");
  });
});

describe("trimToUndefined", () => {
  it("returns undefined for non-string values", () => {
    expect(trimToUndefined(42)).toBeUndefined();
    expect(trimToUndefined(null)).toBeUndefined();
    expect(trimToUndefined(undefined)).toBeUndefined();
    expect(trimToUndefined(true)).toBeUndefined();
  });

  it("returns undefined for empty or whitespace-only strings", () => {
    expect(trimToUndefined("")).toBeUndefined();
    expect(trimToUndefined("   ")).toBeUndefined();
  });

  it("trims and returns non-empty strings", () => {
    expect(trimToUndefined("  hello  ")).toBe("hello");
    expect(trimToUndefined("test")).toBe("test");
  });
});

describe("asFiniteInteger", () => {
  it("returns floor of finite numbers", () => {
    expect(asFiniteInteger(3.7)).toBe(3);
    expect(asFiniteInteger(5)).toBe(5);
    expect(asFiniteInteger(-2.3)).toBe(-3);
  });

  it("returns undefined for non-finite values", () => {
    expect(asFiniteInteger(NaN)).toBeUndefined();
    expect(asFiniteInteger(Infinity)).toBeUndefined();
    expect(asFiniteInteger(-Infinity)).toBeUndefined();
    expect(asFiniteInteger("5")).toBeUndefined();
    expect(asFiniteInteger(null)).toBeUndefined();
  });
});

describe("readBoundedInt", () => {
  it("returns value within bounds", () => {
    expect(readBoundedInt({ value: 5, label: "x", min: 1, max: 10 })).toBe(5);
  });

  it("returns undefined for non-numeric values", () => {
    expect(readBoundedInt({ value: "hello", label: "x", min: 1 })).toBeUndefined();
    expect(readBoundedInt({ value: undefined, label: "x", min: 1 })).toBeUndefined();
  });

  it("throws when below min", () => {
    expect(() => readBoundedInt({ value: 0, label: "x", min: 1 })).toThrow("x must be >= 1");
  });

  it("throws when above max", () => {
    expect(() => readBoundedInt({ value: 20, label: "x", min: 1, max: 10 })).toThrow(
      "x must be <= 10",
    );
  });

  it("floors decimal values", () => {
    expect(readBoundedInt({ value: 5.9, label: "x", min: 1, max: 10 })).toBe(5);
  });
});
