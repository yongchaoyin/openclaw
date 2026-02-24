import { describe, expect, it } from "vitest";
import {
  formatAccessibilitySnapshot,
  isDesktopCommandSupported,
  listDesktopNodeCaps,
  listDesktopNodeCommands,
} from "./invoke-desktop.js";

describe("node-host desktop command capability detection", () => {
  it("enables desktop caps/commands on darwin", () => {
    expect(isDesktopCommandSupported("darwin")).toBe(true);
    expect(listDesktopNodeCaps("darwin")).toEqual(["desktop"]);
    expect(listDesktopNodeCommands("darwin")).toEqual([
      "desktop.snapshot",
      "desktop.act",
      "desktop.accessibility_snapshot",
    ]);
  });

  it("disables desktop caps/commands on non-darwin platforms", () => {
    expect(isDesktopCommandSupported("linux")).toBe(false);
    expect(listDesktopNodeCaps("linux")).toEqual([]);
    expect(listDesktopNodeCommands("linux")).toEqual([]);
  });
});

describe("formatAccessibilitySnapshot", () => {
  it("returns empty string when result is not ok", () => {
    expect(formatAccessibilitySnapshot({ ok: false, elements: [] })).toBe("");
  });

  it("returns empty string when elements array is empty", () => {
    expect(formatAccessibilitySnapshot({ ok: true, elements: [] })).toBe("");
  });

  it("formats a simple element tree", () => {
    const result = formatAccessibilitySnapshot({
      ok: true,
      elements: [
        {
          role: "Window",
          depth: 0,
          title: "System Settings",
          bounds: { x: 0, y: 38, w: 1200, h: 762 },
        },
        {
          role: "Button",
          depth: 1,
          title: "Close",
          roleDescription: "close button",
          bounds: { x: 8, y: 44, w: 14, h: 14 },
        },
        {
          role: "StaticText",
          depth: 1,
          title: "General",
          bounds: { x: 96, y: 120, w: 60, h: 20 },
        },
      ],
    });
    expect(result).toBe(
      [
        '[Window] "System Settings" (0, 38, 1200, 762)',
        '  [close button] "Close" (8, 44, 14, 14)',
        '  [StaticText] "General" (96, 120, 60, 20)',
      ].join("\n"),
    );
  });

  it("shows disabled state", () => {
    const result = formatAccessibilitySnapshot({
      ok: true,
      elements: [
        {
          role: "Button",
          depth: 0,
          title: "Save",
          bounds: { x: 10, y: 10, w: 80, h: 24 },
          enabled: false,
        },
      ],
    });
    expect(result).toBe('[Button] "Save" (10, 10, 80, 24) [disabled]');
  });

  it("handles elements without labels", () => {
    const result = formatAccessibilitySnapshot({
      ok: true,
      elements: [
        {
          role: "Group",
          depth: 0,
          bounds: { x: 0, y: 0, w: 500, h: 300 },
        },
      ],
    });
    expect(result).toBe("[Group] (0, 0, 500, 300)");
  });

  it("handles elements without bounds", () => {
    const result = formatAccessibilitySnapshot({
      ok: true,
      elements: [{ role: "Application", depth: 0, title: "Finder" }],
    });
    expect(result).toBe('[Application] "Finder"');
  });
});
