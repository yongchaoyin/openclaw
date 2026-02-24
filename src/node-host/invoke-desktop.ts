import { spawn } from "node:child_process";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

const DESKTOP_SNAPSHOT_DEFAULT_TIMEOUT_MS = 20_000;
const DESKTOP_ACT_DEFAULT_TIMEOUT_MS = 15_000;
const DESKTOP_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

export const DESKTOP_SNAPSHOT_COMMAND = "desktop.snapshot";
export const DESKTOP_ACT_COMMAND = "desktop.act";
export const DESKTOP_ACCESSIBILITY_SNAPSHOT_COMMAND = "desktop.accessibility_snapshot";

const DESKTOP_SUPPORTED_PLATFORM = "darwin";

type DesktopSnapshotParams = {
  format?: string;
  maxWidth?: number;
  quality?: number;
  mainDisplayOnly?: boolean;
  timeoutMs?: number;
};

type DesktopActParams = {
  kind?: string;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  durationMs?: number;
  deltaX?: number;
  deltaY?: number;
  text?: string;
  keys?: string[];
  ms?: number;
  button?: string;
  timeoutMs?: number;
};

type DesktopActKind =
  | "click"
  | "doubleClick"
  | "rightClick"
  | "move"
  | "drag"
  | "type"
  | "hotkey"
  | "scroll"
  | "wait"
  | "done";

type DesktopActNormalized = {
  kind: DesktopActKind;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  durationMs?: number;
  deltaX?: number;
  deltaY?: number;
  text?: string;
  keys?: string[];
  ms?: number;
  button?: "left" | "right" | "middle";
  timeoutMs?: number;
};

type RunProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type RunProcessOptions = {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
};

const DESKTOP_OPERATOR_JXA = `
ObjC.import("Foundation");
ObjC.import("ApplicationServices");

function fail(message) {
  throw new Error(message);
}

function envValue(name) {
  var value = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  return value ? ObjC.unwrap(value) : "";
}

function toFiniteNumber(value, name) {
  var n = Number(value);
  if (!isFinite(n)) {
    fail("INVALID_REQUEST: " + name + " required");
  }
  return n;
}

function optionalFiniteNumber(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  var n = Number(value);
  if (!isFinite(n)) {
    fail("INVALID_REQUEST: numeric value required");
  }
  return n;
}

function sleepMs(ms) {
  if (ms > 0) {
    $.NSThread.sleepForTimeInterval(ms / 1000.0);
  }
}

function requireAccessibility() {
  if (!$.AXIsProcessTrusted()) {
    fail(
      "UNAVAILABLE: Accessibility permission required (System Settings > Privacy & Security > Accessibility).",
    );
  }
}

function normalizeButton(raw) {
  var value = String(raw || "left").trim().toLowerCase();
  if (value === "right") {
    return "right";
  }
  if (value === "middle") {
    return "middle";
  }
  return "left";
}

function buttonConst(button) {
  if (button === "right") {
    return $.kCGMouseButtonRight;
  }
  if (button === "middle") {
    return $.kCGMouseButtonCenter;
  }
  return $.kCGMouseButtonLeft;
}

function mouseEventKinds(button) {
  if (button === "right") {
    return {
      down: $.kCGEventRightMouseDown,
      up: $.kCGEventRightMouseUp,
      dragged: $.kCGEventRightMouseDragged,
    };
  }
  if (button === "middle") {
    return {
      down: $.kCGEventOtherMouseDown,
      up: $.kCGEventOtherMouseUp,
      dragged: $.kCGEventOtherMouseDragged,
    };
  }
  return {
    down: $.kCGEventLeftMouseDown,
    up: $.kCGEventLeftMouseUp,
    dragged: $.kCGEventLeftMouseDragged,
  };
}

function postMouse(source, eventType, x, y, button, clickState) {
  var event = $.CGEventCreateMouseEvent(source, eventType, $.CGPointMake(x, y), button);
  if (!event) {
    fail("UNAVAILABLE: failed to create mouse event");
  }
  if (clickState !== undefined && clickState !== null) {
    $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, clickState);
  }
  $.CGEventPost($.kCGHIDEventTap, event);
}

function performClick(source, params) {
  var x = toFiniteNumber(params.x, "x");
  var y = toFiniteNumber(params.y, "y");
  var button = normalizeButton(params.button);
  var buttonValue = buttonConst(button);
  var kinds = mouseEventKinds(button);
  var count = params.kind === "doubleClick" ? 2 : 1;

  postMouse(source, $.kCGEventMouseMoved, x, y, buttonValue);
  for (var i = 1; i <= count; i += 1) {
    postMouse(source, kinds.down, x, y, buttonValue, i);
    postMouse(source, kinds.up, x, y, buttonValue, i);
  }
}

function performMove(source, params) {
  var x = toFiniteNumber(params.x, "x");
  var y = toFiniteNumber(params.y, "y");
  postMouse(source, $.kCGEventMouseMoved, x, y, $.kCGMouseButtonLeft);
}

function performDrag(source, params) {
  var fromX = toFiniteNumber(params.fromX, "fromX");
  var fromY = toFiniteNumber(params.fromY, "fromY");
  var toX = toFiniteNumber(params.toX, "toX");
  var toY = toFiniteNumber(params.toY, "toY");
  var durationMs = optionalFiniteNumber(params.durationMs, 180);
  if (durationMs < 0) {
    durationMs = 0;
  }
  durationMs = Math.min(durationMs, 5000);
  var steps = Math.max(2, Math.min(120, Math.round(durationMs / 12) || 12));
  var stepMs = durationMs <= 0 ? 0 : durationMs / steps;
  var button = $.kCGMouseButtonLeft;
  var kinds = mouseEventKinds("left");

  postMouse(source, $.kCGEventMouseMoved, fromX, fromY, button);
  postMouse(source, kinds.down, fromX, fromY, button, 1);
  for (var i = 1; i <= steps; i += 1) {
    var t = i / steps;
    var x = fromX + (toX - fromX) * t;
    var y = fromY + (toY - fromY) * t;
    postMouse(source, kinds.dragged, x, y, button);
    sleepMs(stepMs);
  }
  postMouse(source, kinds.up, toX, toY, button, 1);
}

// CGEventKeyboardSetUnicodeString has a hard limit of ~20 UniChar per event.
// Split text into chunks and post each as a separate key event pair.
var MAX_UNICODE_CHUNK = 20;

function postUnicodeText(source, text) {
  var nsFullText = $.NSString.stringWithString(text);
  var totalLen = nsFullText.length;
  var offset = 0;

  while (offset < totalLen) {
    var chunkLen = Math.min(MAX_UNICODE_CHUNK, totalLen - offset);
    var chunk = nsFullText.substringWithRange($.NSMakeRange(offset, chunkLen));

    var down = $.CGEventCreateKeyboardEvent(source, 0, true);
    if (!down) {
      fail("UNAVAILABLE: failed to create keyboard event");
    }
    $.CGEventKeyboardSetUnicodeString(down, chunkLen, chunk);
    $.CGEventPost($.kCGHIDEventTap, down);

    var up = $.CGEventCreateKeyboardEvent(source, 0, false);
    if (!up) {
      fail("UNAVAILABLE: failed to create keyboard event");
    }
    $.CGEventKeyboardSetUnicodeString(up, chunkLen, chunk);
    $.CGEventPost($.kCGHIDEventTap, up);

    offset += chunkLen;

    // Small delay between chunks to allow the system to process each event
    if (offset < totalLen) {
      sleepMs(10);
    }
  }
}

function performType(source, params) {
  var text = String(params.text || "");
  if (!text) {
    fail("INVALID_REQUEST: text required");
  }
  // Use System Events keystroke for reliable text input into any focused field
  // (CGEvent Unicode events do not reach some system UI like Spotlight).
  var se = Application("System Events");
  se.keystroke(text);
}

function modifierFromToken(token) {
  if (token === "cmd" || token === "command" || token === "meta") {
    return "command";
  }
  if (token === "ctrl" || token === "control") {
    return "control";
  }
  if (token === "alt" || token === "option") {
    return "option";
  }
  if (token === "shift") {
    return "shift";
  }
  return null;
}

var KEY_CODE_MAP = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "=": 24,
  "9": 25,
  "7": 26,
  "-": 27,
  "8": 28,
  "0": 29,
  "]": 30,
  o: 31,
  u: 32,
  "[": 33,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ";": 41,
  "\\\\": 42,
  ",": 43,
  "/": 44,
  n: 45,
  m: 46,
  ".": 47,
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

function performHotkey(source, params) {
  var rawKeys = params.keys;
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    fail("INVALID_REQUEST: keys required for hotkey");
  }
  var normalized = [];
  for (var i = 0; i < rawKeys.length; i += 1) {
    var token = String(rawKeys[i] || "").trim().toLowerCase();
    if (token) {
      normalized.push(token);
    }
  }
  if (normalized.length === 0) {
    fail("INVALID_REQUEST: keys required for hotkey");
  }

  var modifierState = {
    command: false,
    control: false,
    option: false,
    shift: false,
  };
  var mainKey = null;

  for (var j = 0; j < normalized.length; j += 1) {
    var token = normalized[j];
    var modifier = modifierFromToken(token);
    if (modifier) {
      modifierState[modifier] = true;
    } else {
      mainKey = token;
    }
  }

  if (!mainKey) {
    fail("INVALID_REQUEST: hotkey requires a non-modifier key");
  }

  var keyCode = KEY_CODE_MAP[mainKey];
  if (keyCode === undefined || keyCode === null) {
    fail("INVALID_REQUEST: unsupported hotkey key: " + mainKey);
  }

  var flags = 0;
  if (modifierState.command) {
    flags |= $.kCGEventFlagMaskCommand;
  }
  if (modifierState.control) {
    flags |= $.kCGEventFlagMaskControl;
  }
  if (modifierState.option) {
    flags |= $.kCGEventFlagMaskAlternate;
  }
  if (modifierState.shift) {
    flags |= $.kCGEventFlagMaskShift;
  }

  var down = $.CGEventCreateKeyboardEvent(source, keyCode, true);
  if (!down) {
    fail("UNAVAILABLE: failed to create keyboard event");
  }
  $.CGEventSetFlags(down, flags);
  $.CGEventPost($.kCGHIDEventTap, down);

  var up = $.CGEventCreateKeyboardEvent(source, keyCode, false);
  if (!up) {
    fail("UNAVAILABLE: failed to create keyboard event");
  }
  $.CGEventSetFlags(up, flags);
  $.CGEventPost($.kCGHIDEventTap, up);
}

function performScroll(source, params) {
  var deltaX = Math.round(optionalFiniteNumber(params.deltaX, 0));
  var deltaY = Math.round(optionalFiniteNumber(params.deltaY, 0));
  if (deltaX === 0 && deltaY === 0) {
    fail("INVALID_REQUEST: scroll requires deltaX or deltaY");
  }
  var event = $.CGEventCreateScrollWheelEvent(
    source,
    $.kCGScrollEventUnitLine,
    2,
    deltaY,
    deltaX,
  );
  if (!event) {
    fail("UNAVAILABLE: failed to create scroll event");
  }
  $.CGEventPost($.kCGHIDEventTap, event);
}

(function main() {
  var raw = envValue("OPENCLAW_DESKTOP_ACT_JSON");
  if (!raw) {
    fail("INVALID_REQUEST: missing action payload");
  }
  var action;
  try {
    action = JSON.parse(raw);
  } catch (_err) {
    fail("INVALID_REQUEST: action payload must be valid JSON");
  }

  var kind = String((action && action.kind) || "").trim();
  if (!kind) {
    fail("INVALID_REQUEST: kind required");
  }

  if (kind === "wait") {
    var waitMs = optionalFiniteNumber(action.ms, 250);
    if (waitMs < 0) {
      waitMs = 0;
    }
    waitMs = Math.min(waitMs, 60000);
    sleepMs(waitMs);
    console.log(JSON.stringify({ ok: true, kind: "wait", waitedMs: waitMs }));
    return;
  }

  if (kind === "done") {
    console.log(JSON.stringify({ ok: true, kind: "done" }));
    return;
  }

  requireAccessibility();
  var source = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
  if (!source) {
    fail("UNAVAILABLE: failed to create HID event source");
  }

  if (kind === "click" || kind === "doubleClick") {
    performClick(source, action);
  } else if (kind === "rightClick") {
    action.button = "right";
    action.kind = "click";
    performClick(source, action);
  } else if (kind === "move") {
    performMove(source, action);
  } else if (kind === "drag") {
    performDrag(source, action);
  } else if (kind === "type") {
    performType(source, action);
  } else if (kind === "hotkey") {
    performHotkey(source, action);
  } else if (kind === "scroll") {
    performScroll(source, action);
  } else {
    fail("INVALID_REQUEST: unsupported desktop.act kind: " + kind);
  }

  console.log(JSON.stringify({ ok: true, kind: kind }));
})();
`;

// JXA script that walks the macOS accessibility tree (AXUIElement) and returns
// a structured list of UI elements with their role, title/value, and bounds.
// The output is a flat JSON array written to stdout.
const DESKTOP_ACCESSIBILITY_JXA = `
ObjC.import("Foundation");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");

var MAX_DEPTH = 8;
var MAX_ELEMENTS = 200;
var collected = 0;

function axValue(element, attr) {
  var ref = Ref();
  var err = $.AXUIElementCopyAttributeValue(element, attr, ref);
  if (err !== 0) {
    return undefined;
  }
  var value = ref[0];
  if (value === undefined || value === null) {
    return undefined;
  }
  return value;
}

function axStringValue(element, attr) {
  var value = axValue(element, attr);
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return ObjC.unwrap(value) || "";
  } catch (_e) {
    return String(value);
  }
}

function axPosition(element) {
  var ref = Ref();
  var err = $.AXUIElementCopyAttributeValue(element, "AXPosition", ref);
  if (err !== 0) {
    return null;
  }
  var point = Ref();
  if (!$.AXValueGetValue(ref[0], $.kAXValueCGPointType, point)) {
    return null;
  }
  return { x: point[0].x, y: point[0].y };
}

function axSize(element) {
  var ref = Ref();
  var err = $.AXUIElementCopyAttributeValue(element, "AXSize", ref);
  if (err !== 0) {
    return null;
  }
  var size = Ref();
  if (!$.AXValueGetValue(ref[0], $.kAXValueCGSizeType, size)) {
    return null;
  }
  return { w: size[0].width, h: size[0].height };
}

function axChildren(element) {
  var ref = Ref();
  var err = $.AXUIElementCopyAttributeValue(element, "AXChildren", ref);
  if (err !== 0) {
    return [];
  }
  var children = ref[0];
  if (!children || typeof children.count !== "function") {
    return [];
  }
  var result = [];
  var count = children.count;
  for (var i = 0; i < count; i++) {
    result.push(children.objectAtIndex(i));
  }
  return result;
}

function walkElement(element, depth, results) {
  if (collected >= MAX_ELEMENTS || depth > MAX_DEPTH) {
    return;
  }
  var role = axStringValue(element, "AXRole");
  if (!role) {
    return;
  }
  // Skip invisible elements
  var hidden = axValue(element, "AXHidden");
  if (hidden === true || hidden === 1) {
    return;
  }

  var subrole = axStringValue(element, "AXSubrole");
  var title = axStringValue(element, "AXTitle");
  var value = axStringValue(element, "AXValue");
  var roleDesc = axStringValue(element, "AXRoleDescription");
  var enabled = axValue(element, "AXEnabled");
  var pos = axPosition(element);
  var size = axSize(element);

  // Skip zero-size elements
  if (size && size.w === 0 && size.h === 0) {
    return;
  }

  var entry = {
    role: role.replace(/^AX/, ""),
    depth: depth,
  };
  if (subrole) {
    entry.subrole = subrole.replace(/^AX/, "");
  }
  if (title) {
    entry.title = title.substring(0, 200);
  }
  if (value && typeof value === "string") {
    entry.value = value.substring(0, 200);
  }
  if (roleDesc) {
    entry.roleDescription = roleDesc.substring(0, 100);
  }
  if (pos && size) {
    entry.bounds = {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      w: Math.round(size.w),
      h: Math.round(size.h),
    };
  }
  if (enabled === false || enabled === 0) {
    entry.enabled = false;
  }

  results.push(entry);
  collected++;

  var children = axChildren(element);
  for (var i = 0; i < children.length; i++) {
    if (collected >= MAX_ELEMENTS) {
      break;
    }
    walkElement(children[i], depth + 1, results);
  }
}

(function main() {
  if (!$.AXIsProcessTrusted()) {
    console.log(JSON.stringify({
      ok: false,
      error: "UNAVAILABLE: Accessibility permission required (System Settings > Privacy & Security > Accessibility).",
      elements: [],
    }));
    return;
  }

  var systemWide = $.AXUIElementCreateSystemWide();
  var focusedAppRef = Ref();
  var err = $.AXUIElementCopyAttributeValue(systemWide, "AXFocusedApplication", focusedAppRef);
  if (err !== 0) {
    console.log(JSON.stringify({
      ok: false,
      error: "UNAVAILABLE: no focused application found",
      elements: [],
    }));
    return;
  }

  var app = focusedAppRef[0];
  var appTitle = "";
  try {
    appTitle = ObjC.unwrap(axValue(app, "AXTitle")) || "";
  } catch (_e) {}

  // Get focused window
  var windowRef = Ref();
  err = $.AXUIElementCopyAttributeValue(app, "AXFocusedWindow", windowRef);
  var targetElement = err === 0 && windowRef[0] ? windowRef[0] : app;

  var results = [];
  walkElement(targetElement, 0, results);

  console.log(JSON.stringify({
    ok: true,
    app: appTitle,
    elementCount: results.length,
    truncated: collected >= MAX_ELEMENTS,
    elements: results,
  }));
})();
`;

const DESKTOP_ACCESSIBILITY_SNAPSHOT_DEFAULT_TIMEOUT_MS = 10_000;

type DesktopAccessibilitySnapshotParams = {
  timeoutMs?: number;
};

type DesktopAccessibilityElement = {
  role: string;
  depth: number;
  subrole?: string;
  title?: string;
  value?: string;
  roleDescription?: string;
  bounds?: { x: number; y: number; w: number; h: number };
  enabled?: boolean;
};

type DesktopAccessibilityResult = {
  ok: boolean;
  error?: string;
  app?: string;
  elementCount?: number;
  truncated?: boolean;
  elements: DesktopAccessibilityElement[];
};

function decodeParamsRequired<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  return JSON.parse(raw) as T;
}

function decodeParamsOptional<T>(raw?: string | null): T {
  if (!raw) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

function normalizeImageFormat(raw?: string): "png" | "jpeg" {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "png") {
    return "png";
  }
  if (value === "jpeg" || value === "jpg") {
    return "jpeg";
  }
  throw new Error("INVALID_REQUEST: format must be png|jpeg");
}

function normalizeButton(raw?: string): "left" | "right" | "middle" {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "left") {
    return "left";
  }
  if (value === "right") {
    return "right";
  }
  if (value === "middle") {
    return "middle";
  }
  throw new Error("INVALID_REQUEST: button must be left|right|middle");
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`INVALID_REQUEST: ${name} required`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function positiveOptionalInteger(value: unknown, name: string): number | undefined {
  const num = optionalFiniteNumber(value);
  if (num === undefined) {
    return undefined;
  }
  if (num <= 0) {
    throw new Error(`INVALID_REQUEST: ${name} must be > 0`);
  }
  return Math.floor(num);
}

function normalizeDesktopActParams(params: DesktopActParams): DesktopActNormalized {
  const kind = String(params.kind ?? "").trim() as DesktopActKind;
  if (!kind) {
    throw new Error("INVALID_REQUEST: kind required");
  }
  const timeoutMs = positiveOptionalInteger(params.timeoutMs, "timeoutMs");
  switch (kind) {
    case "click":
    case "doubleClick":
      return {
        kind,
        x: finiteNumber(params.x, "x"),
        y: finiteNumber(params.y, "y"),
        button: normalizeButton(params.button),
        timeoutMs,
      };
    case "rightClick":
      return {
        kind,
        x: finiteNumber(params.x, "x"),
        y: finiteNumber(params.y, "y"),
        timeoutMs,
      };
    case "move":
      return {
        kind,
        x: finiteNumber(params.x, "x"),
        y: finiteNumber(params.y, "y"),
        timeoutMs,
      };
    case "drag":
      return {
        kind,
        fromX: finiteNumber(params.fromX, "fromX"),
        fromY: finiteNumber(params.fromY, "fromY"),
        toX: finiteNumber(params.toX, "toX"),
        toY: finiteNumber(params.toY, "toY"),
        durationMs: optionalFiniteNumber(params.durationMs),
        timeoutMs,
      };
    case "type": {
      const text = typeof params.text === "string" ? params.text : "";
      if (!text) {
        throw new Error("INVALID_REQUEST: text required");
      }
      if (text.length > 4000) {
        throw new Error("INVALID_REQUEST: text too long (max 4000 chars)");
      }
      return { kind, text, timeoutMs };
    }
    case "hotkey": {
      const keysRaw = Array.isArray(params.keys) ? params.keys : [];
      const keys = keysRaw.map((k) => String(k).trim()).filter(Boolean);
      if (keys.length === 0) {
        throw new Error("INVALID_REQUEST: keys required");
      }
      return { kind, keys, timeoutMs };
    }
    case "scroll": {
      const deltaX = optionalFiniteNumber(params.deltaX) ?? 0;
      const deltaY = optionalFiniteNumber(params.deltaY) ?? 0;
      if (deltaX === 0 && deltaY === 0) {
        throw new Error("INVALID_REQUEST: deltaX or deltaY required");
      }
      return { kind, deltaX, deltaY, timeoutMs };
    }
    case "wait": {
      const msRaw = optionalFiniteNumber(params.ms);
      const ms = msRaw === undefined ? 250 : Math.min(60_000, Math.max(0, msRaw));
      return { kind, ms, timeoutMs };
    }
    case "done":
      return { kind, timeoutMs };
    default:
      throw new Error(
        "INVALID_REQUEST: kind must be click|doubleClick|rightClick|move|drag|type|hotkey|scroll|wait|done",
      );
  }
}

function describeProcessFailure(
  label: string,
  result: RunProcessResult,
  opts?: { fallbackMessage?: string },
): Error {
  if (result.timedOut) {
    return new Error(`${label} timed out`);
  }
  const errText = `${result.stderr}\n${result.stdout}`.trim();
  const message = errText || opts?.fallbackMessage || `${label} failed`;
  return new Error(message);
}

async function runProcess(
  command: string,
  args: string[],
  options?: RunProcessOptions,
): Promise<RunProcessResult> {
  const mergedEnv =
    options?.env !== undefined
      ? (() => {
          const env: Record<string, string> = {};
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              env[key] = value;
            }
          }
          for (const [key, value] of Object.entries(options.env ?? {})) {
            if (value === undefined) {
              delete env[key];
            } else {
              env[key] = value;
            }
          }
          return env;
        })()
      : undefined;

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: mergedEnv,
      windowsHide: true,
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk as string;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk as string;
    });

    let timeout: NodeJS.Timeout | undefined;
    if (options?.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, options.timeoutMs);
    }

    const finalize = (exitCode: number | null) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
      });
    };

    child.on("error", (err) => {
      stderr = `${stderr}\n${err.message}`.trim();
      finalize(null);
    });
    child.on("close", (code) => {
      finalize(code);
    });
  });
}

async function ensureDesktopSupported() {
  if (!isDesktopCommandSupported()) {
    throw new Error("UNAVAILABLE: desktop operator currently supports macOS only");
  }
}

function parseSipsImageSize(output: string): { width?: number; height?: number } {
  const widthMatch = output.match(/pixelWidth:\s*(\d+)/i);
  const heightMatch = output.match(/pixelHeight:\s*(\d+)/i);
  return {
    width: widthMatch ? Number.parseInt(widthMatch[1], 10) : undefined,
    height: heightMatch ? Number.parseInt(heightMatch[1], 10) : undefined,
  };
}

async function readImageSize(filePath: string, timeoutMs: number) {
  const result = await runProcess(
    "/usr/bin/sips",
    ["-g", "pixelWidth", "-g", "pixelHeight", filePath],
    { timeoutMs },
  );
  if (result.exitCode !== 0 || result.timedOut) {
    return {};
  }
  return parseSipsImageSize(result.stdout);
}

/** Get the main display's logical size and backing scale factor via JXA. */
async function readScreenInfo(
  timeoutMs: number,
): Promise<{ screenWidth?: number; screenHeight?: number; scaleFactor?: number }> {
  // Use NSScreen to get logical size and backingScaleFactor
  const script = `
    ObjC.import("AppKit");
    var screen = $.NSScreen.mainScreen;
    var frame = screen.frame;
    var scale = screen.backingScaleFactor;
    console.log(JSON.stringify({
      w: Math.round(frame.size.width),
      h: Math.round(frame.size.height),
      s: scale,
    }));
  `;
  const result = await runProcess("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
    timeoutMs,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    return {};
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { w?: number; h?: number; s?: number };
    return {
      screenWidth: typeof parsed.w === "number" ? parsed.w : undefined,
      screenHeight: typeof parsed.h === "number" ? parsed.h : undefined,
      scaleFactor: typeof parsed.s === "number" ? parsed.s : undefined,
    };
  } catch {
    return {};
  }
}

export function isDesktopCommandSupported(platform = process.platform): boolean {
  return platform === DESKTOP_SUPPORTED_PLATFORM;
}

export function listDesktopNodeCaps(platform = process.platform): string[] {
  return isDesktopCommandSupported(platform) ? ["desktop"] : [];
}

export function listDesktopNodeCommands(platform = process.platform): string[] {
  if (!isDesktopCommandSupported(platform)) {
    return [];
  }
  return [DESKTOP_SNAPSHOT_COMMAND, DESKTOP_ACT_COMMAND, DESKTOP_ACCESSIBILITY_SNAPSHOT_COMMAND];
}

export async function runDesktopSnapshotCommand(paramsJSON?: string | null): Promise<string> {
  await ensureDesktopSupported();
  const params = decodeParamsOptional<DesktopSnapshotParams>(paramsJSON);
  const format = normalizeImageFormat(params.format);
  const requestedMaxWidth = positiveOptionalInteger(params.maxWidth, "maxWidth");
  const qualityRaw = optionalFiniteNumber(params.quality);
  const quality = qualityRaw === undefined ? undefined : Math.max(0.05, Math.min(1, qualityRaw));
  const timeoutMs =
    positiveOptionalInteger(params.timeoutMs, "timeoutMs") ?? DESKTOP_SNAPSHOT_DEFAULT_TIMEOUT_MS;
  const mainDisplayOnly = params.mainDisplayOnly !== false;

  const baseTmp = resolvePreferredOpenClawTmpDir();
  await fsPromises.mkdir(baseTmp, { recursive: true, mode: 0o700 });
  const workDir = await fsPromises.mkdtemp(path.join(baseTmp, "desktop-snapshot-"));
  const capturePath = path.join(workDir, "capture.png");

  try {
    const captureArgs = ["-x", ...(mainDisplayOnly ? ["-m"] : []), capturePath];
    // Run screencapture and screen-info lookup in parallel for speed.
    const [capture, screenInfo] = await Promise.all([
      runProcess("/usr/sbin/screencapture", captureArgs, { timeoutMs }),
      readScreenInfo(timeoutMs),
    ]);
    if (capture.exitCode !== 0) {
      throw describeProcessFailure("desktop snapshot", capture, {
        fallbackMessage:
          "UNAVAILABLE: screen capture failed (grant Screen Recording permission and retry).",
      });
    }

    const captureStat = await fsPromises.stat(capturePath).catch(() => null);
    if (!captureStat || !captureStat.isFile() || captureStat.size === 0) {
      throw new Error(
        "UNAVAILABLE: desktop snapshot is empty (grant Screen Recording permission and retry)",
      );
    }
    const autoMaxWidth =
      mainDisplayOnly &&
      typeof screenInfo.screenWidth === "number" &&
      typeof screenInfo.scaleFactor === "number" &&
      screenInfo.scaleFactor > 1.01
        ? screenInfo.screenWidth
        : undefined;
    const effectiveMaxWidth =
      typeof requestedMaxWidth === "number" && typeof autoMaxWidth === "number"
        ? Math.min(requestedMaxWidth, autoMaxWidth)
        : (requestedMaxWidth ?? autoMaxWidth);

    if (effectiveMaxWidth) {
      const resize = await runProcess(
        "/usr/bin/sips",
        ["-Z", String(effectiveMaxWidth), capturePath],
        { timeoutMs },
      );
      if (resize.exitCode !== 0) {
        throw describeProcessFailure("desktop snapshot resize", resize);
      }
    }

    let finalPath = capturePath;
    if (format === "jpeg") {
      const jpegPath = path.join(workDir, "capture.jpg");
      const convertArgs = [
        "-s",
        "format",
        "jpeg",
        ...(quality ? ["-s", "formatOptions", String(Math.round(quality * 100))] : []),
        capturePath,
        "--out",
        jpegPath,
      ];
      const convert = await runProcess("/usr/bin/sips", convertArgs, { timeoutMs });
      if (convert.exitCode !== 0) {
        throw describeProcessFailure("desktop snapshot convert", convert);
      }
      finalPath = jpegPath;
    }

    const data = await fsPromises.readFile(finalPath);
    if (data.length === 0) {
      throw new Error("UNAVAILABLE: desktop snapshot is empty");
    }
    if (data.length > DESKTOP_SNAPSHOT_MAX_BYTES) {
      throw new Error(
        `UNAVAILABLE: desktop snapshot too large (${data.length} bytes). Retry with maxWidth to reduce size.`,
      );
    }

    const size = await readImageSize(finalPath, timeoutMs);
    return JSON.stringify({
      format,
      base64: data.toString("base64"),
      ...(size.width ? { width: size.width } : {}),
      ...(size.height ? { height: size.height } : {}),
      ...(screenInfo.screenWidth ? { screenWidth: screenInfo.screenWidth } : {}),
      ...(screenInfo.screenHeight ? { screenHeight: screenInfo.screenHeight } : {}),
      ...(screenInfo.scaleFactor ? { scaleFactor: screenInfo.scaleFactor } : {}),
    });
  } finally {
    await fsPromises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseDesktopActResult(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: true };
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { ok: true, output: trimmed };
  }
}

export async function runDesktopActCommand(paramsJSON?: string | null): Promise<string> {
  await ensureDesktopSupported();
  const params = decodeParamsRequired<DesktopActParams>(paramsJSON);
  const action = normalizeDesktopActParams(params);
  const timeoutMs = action.timeoutMs ?? DESKTOP_ACT_DEFAULT_TIMEOUT_MS;

  if (action.kind === "wait") {
    const waitMs = action.ms ?? 250;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return JSON.stringify({ ok: true, kind: "wait", waitedMs: waitMs });
  }

  if (action.kind === "done") {
    return JSON.stringify({ ok: true, kind: "done" });
  }

  const osa = await runProcess(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", DESKTOP_OPERATOR_JXA],
    {
      timeoutMs,
      env: {
        OPENCLAW_DESKTOP_ACT_JSON: JSON.stringify(action),
      },
    },
  );

  if (osa.exitCode !== 0) {
    throw describeProcessFailure("desktop action", osa);
  }

  const payload = parseDesktopActResult(osa.stdout);
  return JSON.stringify(payload);
}

/** Format accessibility elements into an indented text tree (similar to browser snapshot). */
export function formatAccessibilitySnapshot(result: DesktopAccessibilityResult): string {
  if (!result.ok || result.elements.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (const el of result.elements) {
    const indent = "  ".repeat(el.depth);
    const label = el.title || el.value || "";
    const boundsStr = el.bounds
      ? ` (${el.bounds.x}, ${el.bounds.y}, ${el.bounds.w}, ${el.bounds.h})`
      : "";
    const disabledStr = el.enabled === false ? " [disabled]" : "";
    const roleName = el.roleDescription || el.role;
    if (label) {
      lines.push(`${indent}[${roleName}] "${label}"${boundsStr}${disabledStr}`);
    } else {
      lines.push(`${indent}[${roleName}]${boundsStr}${disabledStr}`);
    }
  }
  return lines.join("\n");
}

export async function runDesktopAccessibilitySnapshotCommand(
  paramsJSON?: string | null,
): Promise<string> {
  await ensureDesktopSupported();
  const params = decodeParamsOptional<DesktopAccessibilitySnapshotParams>(paramsJSON);
  const timeoutMs =
    positiveOptionalInteger(params.timeoutMs, "timeoutMs") ??
    DESKTOP_ACCESSIBILITY_SNAPSHOT_DEFAULT_TIMEOUT_MS;

  const osa = await runProcess(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", DESKTOP_ACCESSIBILITY_JXA],
    { timeoutMs },
  );

  if (osa.exitCode !== 0) {
    throw describeProcessFailure("desktop accessibility snapshot", osa);
  }

  const trimmed = osa.stdout.trim();
  if (!trimmed) {
    return JSON.stringify({ ok: false, error: "empty output", elements: [], text: "" });
  }

  let parsed: DesktopAccessibilityResult;
  try {
    parsed = JSON.parse(trimmed) as DesktopAccessibilityResult;
  } catch {
    return JSON.stringify({ ok: false, error: "invalid JSON output", elements: [], text: "" });
  }

  const text = formatAccessibilitySnapshot(parsed);
  return JSON.stringify({
    ...parsed,
    text,
  });
}
