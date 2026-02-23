import { describe, expect, it } from "vitest";
import {
  isDesktopCommandSupported,
  listDesktopNodeCaps,
  listDesktopNodeCommands,
} from "./invoke-desktop.js";

describe("node-host desktop command capability detection", () => {
  it("enables desktop caps/commands on darwin", () => {
    expect(isDesktopCommandSupported("darwin")).toBe(true);
    expect(listDesktopNodeCaps("darwin")).toEqual(["desktop"]);
    expect(listDesktopNodeCommands("darwin")).toEqual(["desktop.snapshot", "desktop.act"]);
  });

  it("disables desktop caps/commands on non-darwin platforms", () => {
    expect(isDesktopCommandSupported("linux")).toBe(false);
    expect(listDesktopNodeCaps("linux")).toEqual([]);
    expect(listDesktopNodeCommands("linux")).toEqual([]);
  });
});
