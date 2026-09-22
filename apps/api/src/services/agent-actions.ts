import type { VirtualizationProvider } from "../providers/types.js";
import {
  browserClickSelector, browserEvaluate, browserNavigate, browserOpenTab, browserPressKey,
  browserState, browserTypeSelector, captureScreenshot, desktopActions, displayGeometry,
  focusBrowserWindow, openVisibleTerminal, run
} from "./desktop.js";

// The single vocabulary of things an agent may do to a computer. Everything is one of these
// actions, every action returns an explicit success/failure, and every action that changes
// something drives the real visible desktop (X11 input or the visible Chromium's DevTools).
export type AgentAction =
  | { type: "move"; x: number; y: number }
  | { type: "click"; x: number; y: number; button?: number; clicks?: number }
  | { type: "double_click"; x: number; y: number }
  | { type: "right_click"; x: number; y: number }
  | { type: "type"; text: string; delayMs?: number }
  | { type: "key"; keys: string }
  | { type: "scroll"; x?: number; y?: number; direction: "up" | "down"; amount?: number }
  | { type: "drag"; fromX: number; fromY: number; toX: number; toY: number; button?: number }
  | { type: "browser_navigate"; url: string }
  | { type: "browser_open_tab"; url?: string }
  | { type: "browser_click"; selector: string }
  | { type: "browser_type"; selector: string; text: string }
  | { type: "browser_press"; key: string }
  | { type: "browser_evaluate"; expression: string }
  | { type: "focus_browser" }
  | { type: "open_terminal" }
  | { type: "visible_command"; command: string }
  | { type: "terminal_command"; command: string; timeoutMs?: number }
  | { type: "screenshot" }
  | { type: "wait"; ms: number };

export const agentActionTypes = [
  "move", "click", "double_click", "right_click", "type", "key", "scroll", "drag",
  "browser_navigate", "browser_open_tab", "browser_click", "browser_type", "browser_press",
  "browser_evaluate", "focus_browser", "open_terminal", "visible_command", "terminal_command",
  "screenshot", "wait"
] as const;

export interface ActionContext {
  provider: VirtualizationProvider;
  instanceId: string;
  cdpPort: number;
}

export interface ActionResult { ok: boolean; message: string; detail: Record<string, unknown>; }

// Only operational facts belong in the durable, owner-visible activity stream. Values read *out*
// of the computer (page text, DOM reads, command output, cookies) stay in the action response for
// the caller and are never persisted where they could be replayed later.
const SAFE_METADATA_KEYS = ["method", "exitCode", "bytes", "length", "selector", "key", "direction", "amount", "clicks", "button", "ms", "opened", "capturedAt"] as const;
const SAFE_METADATA_MAX_STRING = 120;

export function safeActivityMetadata(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (!detail) return safe;
  for (const key of SAFE_METADATA_KEYS) {
    const value = detail[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") safe[key] = value.slice(0, SAFE_METADATA_MAX_STRING);
    else if (typeof value === "number" || typeof value === "boolean") safe[key] = value;
  }
  return safe;
}

/** A short, safe label for a URL: the activity stream must never leak query secrets. */
export function describeUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.hostname}${path}`;
  } catch { return value.slice(0, 120); }
}

async function cdpDown(context: ActionContext): Promise<boolean> {
  const state = await browserState(context.provider, context.instanceId, context.cdpPort);
  return Boolean(state);
}

export async function performAction(context: ActionContext, action: AgentAction): Promise<ActionResult> {
  switch (action.type) {
    case "move": {
      const outcome = await desktopActions.move(context.provider, context.instanceId, action.x, action.y);
      return { ok: outcome.ok, message: `Moved the pointer to (${action.x}, ${action.y})`, detail: outcome.detail };
    }
    case "click":
    case "double_click":
    case "right_click": {
      const button = action.type === "right_click" ? 3 : (action.type === "click" ? action.button ?? 1 : 1);
      const clicks = action.type === "double_click" ? 2 : (action.type === "click" ? action.clicks ?? 1 : 1);
      const outcome = await desktopActions.click(context.provider, context.instanceId, action.x, action.y, button, clicks);
      const how = action.type === "double_click" ? "Double-clicked" : action.type === "right_click" ? "Right-clicked" : "Clicked";
      return { ok: outcome.ok, message: `${how} at (${action.x}, ${action.y})`, detail: { ...outcome.detail, button, clicks } };
    }
    case "type": {
      const outcome = await desktopActions.type(context.provider, context.instanceId, action.text, action.delayMs ?? 25);
      // The typed characters are never echoed into the activity stream: they may be secrets.
      return { ok: outcome.ok, message: `Typed ${action.text.length} characters`, detail: outcome.detail };
    }
    case "key": {
      const outcome = await desktopActions.keypress(context.provider, context.instanceId, action.keys);
      return { ok: outcome.ok, message: `Pressed ${action.keys}`, detail: outcome.detail };
    }
    case "scroll": {
      const outcome = await desktopActions.scroll(context.provider, context.instanceId, action.x ?? 720, action.y ?? 450, action.direction, action.amount ?? 3);
      return { ok: outcome.ok, message: `Scrolled ${action.direction}`, detail: outcome.detail };
    }
    case "drag": {
      const outcome = await desktopActions.drag(context.provider, context.instanceId, action.fromX, action.fromY, action.toX, action.toY, action.button ?? 1);
      return { ok: outcome.ok, message: `Dragged from (${action.fromX}, ${action.fromY}) to (${action.toX}, ${action.toY})`, detail: outcome.detail };
    }
    case "focus_browser": {
      const outcome = await focusBrowserWindow(context.provider, context.instanceId);
      return { ok: outcome.ok, message: "Focused the visible Chromium window", detail: outcome.detail };
    }
    case "browser_navigate": {
      const label = describeUrl(action.url);
      if (await cdpDown(context)) {
        const navigated = await browserNavigate(context.provider, context.instanceId, context.cdpPort, action.url);
        if (navigated.ok) return { ok: true, message: `Navigated to ${label}`, detail: { method: "cdp-page-navigate", title: navigated.title ?? null } };
      }
      // Fallback that still drives the visible window: focus Chromium, type the address, press Return.
      const outcome = await desktopActions.keypress(context.provider, context.instanceId, "ctrl+l");
      if (!outcome.ok) return { ok: false, message: `Could not focus the address bar for ${label}`, detail: outcome.detail };
      const typed = await desktopActions.type(context.provider, context.instanceId, action.url, 20);
      const entered = await desktopActions.keypress(context.provider, context.instanceId, "Return");
      return { ok: typed.ok && entered.ok, message: `Navigated to ${label}`, detail: { method: "xdotool-address-bar", ...entered.detail } };
    }
    case "browser_open_tab": {
      const url = action.url ?? "about:blank";
      const opened = await browserOpenTab(context.provider, context.instanceId, context.cdpPort, url);
      if (opened) return { ok: true, message: `Opened a new tab at ${describeUrl(url)}`, detail: { method: "cdp-new-tab" } };
      const launched = await run(context.provider, context.instanceId, "/usr/local/bin/xdigitex-browser", [url], { timeoutMs: 20000, outputLimitBytes: 8192 });
      return { ok: launched.exitCode === 0, message: `Opened a new tab at ${describeUrl(url)}`, detail: { method: "launch", exitCode: launched.exitCode } };
    }
    case "browser_click": {
      const result = await browserClickSelector(context.provider, context.instanceId, context.cdpPort, action.selector);
      if (!result) return { ok: false, message: `No visible element matched ${action.selector}`, detail: { selector: action.selector } };
      return { ok: true, message: `Clicked ${String(result.label || action.selector)}`, detail: result };
    }
    case "browser_type": {
      const result = await browserTypeSelector(context.provider, context.instanceId, context.cdpPort, action.selector, action.text);
      if (!result) return { ok: false, message: `No visible input matched ${action.selector}`, detail: { selector: action.selector } };
      return { ok: true, message: `Typed into ${action.selector}`, detail: { selector: action.selector, length: action.text.length } };
    }
    case "browser_press": {
      const result = await browserPressKey(context.provider, context.instanceId, context.cdpPort, action.key);
      return { ok: Boolean(result), message: `Pressed ${action.key} in the browser`, detail: result ?? {} };
    }
    case "browser_evaluate": {
      const value = await browserEvaluate(context.provider, context.instanceId, context.cdpPort, action.expression);
      return { ok: value !== null && value !== undefined, message: "Read data from the visible page", detail: { value } };
    }
    case "open_terminal": {
      const outcome = await openVisibleTerminal(context.provider, context.instanceId);
      return { ok: outcome.ok, message: "Opened a terminal on the desktop", detail: outcome.detail };
    }
    case "visible_command": {
      // A human watching the screen sees the terminal open, the command typed and the output appear.
      const opened = await openVisibleTerminal(context.provider, context.instanceId);
      if (!opened.ok) return { ok: false, message: "Could not open a terminal", detail: opened.detail };
      await new Promise(resolve => setTimeout(resolve, 2500));
      const typed = await desktopActions.type(context.provider, context.instanceId, action.command, 18);
      const entered = await desktopActions.keypress(context.provider, context.instanceId, "Return");
      await new Promise(resolve => setTimeout(resolve, 1500));
      return { ok: typed.ok && entered.ok, message: `Ran a command in the visible terminal`, detail: { exitCode: entered.detail.exitCode ?? null } };
    }
    case "terminal_command": {
      const execution = await run(context.provider, context.instanceId, "/bin/bash", ["-lc", action.command], { timeoutMs: action.timeoutMs ?? 60000 });
      return { ok: execution.exitCode === 0, message: `Ran a command inside the computer`, detail: { exitCode: execution.exitCode, stdout: execution.stdout.slice(0, 2000), stderr: execution.stderr.slice(0, 1000) } };
    }
    case "screenshot": {
      const screenshot = await captureScreenshot(context.provider, context.instanceId);
      return { ok: true, message: "Captured a screenshot of the desktop", detail: { bytes: screenshot.bytes, capturedAt: screenshot.capturedAt } };
    }
    case "wait": {
      const ms = Math.min(Math.max(action.ms, 100), 120000);
      await new Promise(resolve => setTimeout(resolve, ms));
      return { ok: true, message: `Waited ${ms} ms`, detail: { ms } };
    }
    default:
      return { ok: false, message: "Unsupported action", detail: {} };
  }
}

export async function geometryOf(context: ActionContext): Promise<{ width: number; height: number } | null> {
  return displayGeometry(context.provider, context.instanceId);
}
