import { ProviderError, type ExecuteResult, type VirtualizationProvider } from "../providers/types.js";

// Helpers that turn the control plane's desktop actions into real commands inside an
// AI Computer. Everything here is executed through the provider's audited command path
// (docker exec as the unprivileged agent user) — no shell, no host access.
export const DESKTOP_STATE_DIR = "/home/agent/.xdigitex";

export interface ExecOptions { timeoutMs?: number; outputLimitBytes?: number; }

export async function run(provider: VirtualizationProvider, instanceId: string, executable: string, args: string[], options: ExecOptions = {}): Promise<ExecuteResult> {
  if (!provider.executeCommand) throw new ProviderError("CAPABILITY_UNSUPPORTED", "This provider does not support command execution");
  return provider.executeCommand(instanceId, { executable, arguments: args, timeoutMs: options.timeoutMs ?? 30000, outputLimitBytes: options.outputLimitBytes ?? 262144 });
}

// xdotool drives the real X server, so agent input is visually identical to a human's.
// The providers prepend the executable themselves, so only the xdotool subcommand and its
// arguments are listed here.
export const inputCommands = {
  move: (x: number, y: number) => ["mousemove", "--sync", String(x), String(y)],
  click: (x: number, y: number, button: number, clicks: number) => ["mousemove", "--sync", String(x), String(y), "click", "--repeat", String(clicks), "--delay", "40", String(button)],
  scroll: (x: number, y: number, button: number, amount: number) => ["mousemove", "--sync", String(x), String(y), "click", "--repeat", String(amount), "--delay", "40", String(button)],
  type: (text: string, delayMs: number) => ["type", "--clearmodifiers", "--delay", String(delayMs), "--", text],
  keypress: (keys: string) => ["key", "--clearmodifiers", keys],
  // A drag is one continuous pointer gesture: press, move in steps, release.
  drag: (fromX: number, fromY: number, toX: number, toY: number, button: number) => [
    "mousemove", "--sync", String(fromX), String(fromY),
    "mousedown", String(button),
    "mousemove", "--sync", "--sync", String(Math.round((fromX + toX) / 2)), String(Math.round((fromY + toY) / 2)),
    "mousemove", "--sync", String(toX), String(toY),
    "mouseup", String(button)
  ]
};

export interface ActionOutcome { ok: boolean; detail: Record<string, unknown>; }

// Every desktop action returns an explicit success/failure so an agent never has to guess.
async function xdotool(provider: VirtualizationProvider, instanceId: string, args: string[], options: ExecOptions = {}): Promise<ActionOutcome> {
  const result = await run(provider, instanceId, "/usr/bin/xdotool", args, options);
  return { ok: result.exitCode === 0, detail: { exitCode: result.exitCode, stderr: result.stderr.trim().slice(0, 500), stdout: result.stdout.trim().slice(0, 500) } };
}

export const desktopActions = {
  move: (provider: VirtualizationProvider, instanceId: string, x: number, y: number) => xdotool(provider, instanceId, inputCommands.move(x, y), { timeoutMs: 10000 }),
  click: (provider: VirtualizationProvider, instanceId: string, x: number, y: number, button = 1, clicks = 1) => xdotool(provider, instanceId, inputCommands.click(x, y, button, clicks), { timeoutMs: 20000 }),
  type: (provider: VirtualizationProvider, instanceId: string, text: string, delayMs = 25) => xdotool(provider, instanceId, inputCommands.type(text, delayMs), { timeoutMs: 60000 }),
  keypress: (provider: VirtualizationProvider, instanceId: string, keys: string) => xdotool(provider, instanceId, inputCommands.keypress(keys), { timeoutMs: 20000 }),
  scroll: (provider: VirtualizationProvider, instanceId: string, x: number, y: number, direction: "up" | "down", amount: number) => xdotool(provider, instanceId, inputCommands.scroll(x, y, direction === "up" ? 4 : 5, amount), { timeoutMs: 20000 }),
  drag: (provider: VirtualizationProvider, instanceId: string, fromX: number, fromY: number, toX: number, toY: number, button = 1) => xdotool(provider, instanceId, inputCommands.drag(fromX, fromY, toX, toY, button), { timeoutMs: 30000 })
};

export async function displayGeometry(provider: VirtualizationProvider, instanceId: string): Promise<{ width: number; height: number } | null> {
  try {
    const result = await run(provider, instanceId, "/usr/bin/xdotool", ["getdisplaygeometry"], { timeoutMs: 8000, outputLimitBytes: 4096 });
    if (result.exitCode !== 0) return null;
    const parts = result.stdout.trim().split(/\s+/);
    const width = Number(parts[0]);
    const height = Number(parts[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width, height };
  } catch { return null; }
}

export interface Screenshot { path: string; mimeType: string; base64: string; bytes: number; capturedAt: string; }

export async function captureScreenshot(provider: VirtualizationProvider, instanceId: string): Promise<Screenshot> {
  const directory = `${DESKTOP_STATE_DIR}/screenshots`;
  const capturedAt = new Date().toISOString();
  const path = `${directory}/${capturedAt.replace(/[:.]/g, "-")}.jpg`;
  await run(provider, instanceId, "/bin/mkdir", ["-p", directory], { timeoutMs: 10000, outputLimitBytes: 4096 });
  const capture = await run(provider, instanceId, "/usr/bin/import", ["-window", "root", "-quality", "72", path], { timeoutMs: 40000, outputLimitBytes: 4096 });
  if (capture.exitCode !== 0) throw new ProviderError("OPERATION_FAILED", capture.stderr.trim() || "The desktop screenshot could not be captured");
  await run(provider, instanceId, "/bin/cp", [path, `${directory}/latest.jpg`], { timeoutMs: 10000, outputLimitBytes: 4096 });
  const encoded = await run(provider, instanceId, "/usr/bin/base64", ["-w", "0", path], { timeoutMs: 40000, outputLimitBytes: 4194304 });
  const base64 = encoded.stdout.trim();
  if (!base64) throw new ProviderError("OPERATION_FAILED", "The desktop screenshot could not be read back");
  return { path, mimeType: "image/jpeg", base64, bytes: Buffer.from(base64, "base64").length, capturedAt };
}

// Launches a terminal window on the visible desktop and detaches it from this exec's pipe.
export async function openVisibleTerminal(provider: VirtualizationProvider, instanceId: string): Promise<ActionOutcome> {
  const execution = await run(provider, instanceId, "/bin/bash", ["-lc", "setsid -f /usr/bin/xfce4-terminal --disable-server --working-directory=/home/agent >/dev/null 2>&1 </dev/null"], { timeoutMs: 15000, outputLimitBytes: 8192 });
  return { ok: execution.exitCode === 0, detail: { exitCode: execution.exitCode, stderr: execution.stderr.trim().slice(0, 500) } };
}

/** Waits for the visible Chromium window to own the X input focus, so typing lands in the browser. */
export async function focusBrowserWindow(provider: VirtualizationProvider, instanceId: string): Promise<ActionOutcome> {
  return xdotool(provider, instanceId,
    ["search", "--onlyvisible", "--class", "chromium", "windowactivate", "--sync", "windowfocus", "--sync"],
    { timeoutMs: 20000 });
}

export interface SocketLike { binaryType?: string; readyState: number; send(data: unknown): void; close(code?: number, reason?: string): void; addEventListener(type: string, listener: (event: { data?: unknown }) => void): void; }

export function openWebSocket(url: string, protocols?: string[]): SocketLike {
  const Ctor = (globalThis as unknown as { WebSocket?: new (target: string, protocols?: string[]) => SocketLike }).WebSocket;
  if (typeof Ctor !== "function") throw new ProviderError("CAPABILITY_UNSUPPORTED", "This Node.js runtime does not provide a WebSocket client");
  return protocols ? new Ctor(url, protocols) : new Ctor(url);
}

export interface CdpPage { id: string; url: string; title: string; }
export interface BrowserState { browser: string | null; pages: CdpPage[]; }

// A token pasted into a URL must not travel back out through the console API: keep origin + path.
export function redactUrl(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
  catch { return value.split(/[?#]/)[0] ?? value; }
}

// Chromium runs headful on the XFCE desktop and also exposes the DevTools protocol, so browser
// work is done over the real protocol against that same visible window instead of a separate
// headless browser. There is exactly one Chromium process on this computer: the one on screen.
//
// Chrome refuses to bind its DevTools endpoint to anything but loopback, so the control plane
// cannot talk to it across the container network. It therefore drives the protocol over the
// container's own loopback with the Node.js runtime that ships in the image: Node's built-in
// WebSocket speaks CDP, and no shell is involved anywhere in this path.
const CDP_CLIENT = [
  "(async()=>{",
  "const [mode,port,...rest]=process.argv.slice(1);",
  'const base="http://127.0.0.1:"+port;',
  'const json=async(p,m="GET")=>{const r=await fetch(base+p,{method:m});return r.ok?r.json():null;};',
  "const list=async()=>((await json('/json/list'))||[]).filter(t=>t.type==='page'&&!String(t.url).startsWith('devtools://'));",
  'if(mode==="list"){const v=await json("/json/version");const l=await list();console.log(JSON.stringify({browser:v&&v.Browser,pages:l.map(t=>({id:t.id,url:t.url,title:t.title}))}));return;}',
  'if(mode==="newtab"){const c=await json("/json/new?"+encodeURIComponent(rest[0]),"PUT");console.log(JSON.stringify({opened:Boolean(c),id:c&&c.id}));return;}',
  'if(mode==="close"){await json("/json/close/"+rest[0]);console.log(JSON.stringify({closed:rest[0]}));return;}',
  "const pages=await list();",
  'if(!pages.length)throw new Error("no page target is available");',
  "const page=pages[0];",
  "const ws=new WebSocket(page.webSocketDebuggerUrl);",
  'await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error("devtools socket failed")),15000);ws.onopen=()=>{clearTimeout(t);r();};ws.onerror=()=>{clearTimeout(t);j(new Error("devtools socket failed"));};});',
  "let seq=0;const waiting=new Map();",
  "ws.onmessage=e=>{const m=JSON.parse(e.data);const p=waiting.get(m.id);if(p){waiting.delete(m.id);p(m);}};",
  "const send=(method,params)=>new Promise((res,rej)=>{const id=++seq;const t=setTimeout(()=>{waiting.delete(id);rej(new Error(method+' timed out'));},25000);waiting.set(id,m=>{clearTimeout(t);if(m.error)rej(new Error(m.error.message||method+' failed'));else res(m.result);});ws.send(JSON.stringify({id,method,params:params||{}}));});",
  "const evaluate=async(expression)=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});return r&&r.result?r.result.value:null;};",
  "const state=async()=>({url:(await evaluate('location.href'))||'',title:(await evaluate('document.title'))||'',ready:(await evaluate('document.readyState'))||''});",
  "let out={};",
  'if(mode==="navigate"){await send("Page.enable");await send("Page.navigate",{url:rest[0]});const deadline=Date.now()+20000;for(;;){await new Promise(r=>setTimeout(r,400));const s=await state();if(s.ready==="complete"||Date.now()>deadline){out=s;break;}}}',
  'else if(mode==="eval"){out={value:await evaluate(rest[0])};}',
  'else if(mode==="click"){const sel=rest[0];const box=await evaluate("(()=>{const el=document.querySelector("+JSON.stringify(sel)+");if(!el)return null;el.scrollIntoView({block:\'center\'});el.focus&&el.focus();const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,label:(el.innerText||el.getAttribute(\'aria-label\')||el.href||\'\').trim().slice(0,120)};})()");if(!box)throw new Error("no element matches "+sel);await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:box.x,y:box.y});await send("Input.dispatchMouseEvent",{type:"mousePressed",x:box.x,y:box.y,button:"left",clickCount:1});await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:box.x,y:box.y,button:"left",clickCount:1});out={clicked:sel,x:box.x,y:box.y,label:box.label};}',
  'else if(mode==="type"){const sel=rest[0];const text=rest[1];const box=await evaluate("(()=>{const el=document.querySelector("+JSON.stringify(sel)+");if(!el)return null;el.scrollIntoView({block:\'center\'});el.focus&&el.focus();const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");if(!box)throw new Error("no element matches "+sel);await send("Input.dispatchMouseEvent",{type:"mousePressed",x:box.x,y:box.y,button:"left",clickCount:1});await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:box.x,y:box.y,button:"left",clickCount:1});await send("Input.insertText",{text});out={typed:sel,length:text.length};}',
  'else if(mode==="press"){const key=rest[0];const codes={Enter:13,Tab:9,Escape:27,Backspace:8,ArrowDown:40,ArrowUp:38};const code=codes[key]||0;await send("Input.dispatchKeyEvent",{type:"keyDown",key:key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code});await send("Input.dispatchKeyEvent",{type:"keyUp",key:key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code});out={pressed:key};}',
  'else if(mode==="scroll"){const x=Number(rest[0]),y=Number(rest[1]),dy=Number(rest[2]);await send("Input.dispatchMouseEvent",{type:"mouseWheel",x,y,deltaX:0,deltaY:dy});out={scrolled:dy};}',
  "else throw new Error('unknown cdp mode '+mode);",
  "ws.close();",
  "console.log(JSON.stringify(out));",
  '})().catch(e=>{console.error("CDP_ERROR "+(e&&e.message?e.message:String(e)));process.exit(1);})'
].join("");

export async function cdpCall(provider: VirtualizationProvider, instanceId: string, cdpPort: number, mode: string, args: string[] = [], timeoutMs = 40000): Promise<Record<string, unknown> | null> {
  const result = await run(provider, instanceId, "/usr/bin/node", ["-e", CDP_CLIENT, mode, String(cdpPort), ...args], { timeoutMs, outputLimitBytes: 262144 });
  if (result.exitCode !== 0) return null;
  try { return JSON.parse(result.stdout.trim()) as Record<string, unknown>; } catch { return null; }
}

export async function browserState(provider: VirtualizationProvider, instanceId: string, cdpPort: number): Promise<BrowserState | null> {
  try {
    const parsed = await cdpCall(provider, instanceId, cdpPort, "list", [], 20000) as unknown as BrowserState | null;
    if (!parsed) return null;
    return { browser: parsed.browser ?? null, pages: Array.isArray(parsed.pages) ? parsed.pages : [] };
  } catch { return null; }
}

export async function browserOpenTab(provider: VirtualizationProvider, instanceId: string, cdpPort: number, url: string): Promise<boolean> {
  try {
    const result = await cdpCall(provider, instanceId, cdpPort, "newtab", [url], 30000);
    return result?.opened === true;
  } catch { return false; }
}

export async function browserNavigate(provider: VirtualizationProvider, instanceId: string, cdpPort: number, url: string): Promise<{ ok: boolean; title?: string }> {
  try {
    const result = await cdpCall(provider, instanceId, cdpPort, "navigate", [url], 45000);
    if (!result) return { ok: false };
    return { ok: true, title: typeof result.title === "string" ? result.title : undefined };
  } catch { return { ok: false }; }
}

/** Reads the DOM of the visible page — an agent's "eyes" for structured page content. */
export async function browserEvaluate(provider: VirtualizationProvider, instanceId: string, cdpPort: number, expression: string): Promise<unknown> {
  const result = await cdpCall(provider, instanceId, cdpPort, "eval", [expression], 30000);
  return result ? result.value : null;
}

/** Clicks a real element inside the visible page through the DevTools input domain. */
export async function browserClickSelector(provider: VirtualizationProvider, instanceId: string, cdpPort: number, selector: string) {
  return cdpCall(provider, instanceId, cdpPort, "click", [selector], 30000);
}

export async function browserTypeSelector(provider: VirtualizationProvider, instanceId: string, cdpPort: number, selector: string, text: string) {
  return cdpCall(provider, instanceId, cdpPort, "type", [selector, text], 30000);
}

export async function browserPressKey(provider: VirtualizationProvider, instanceId: string, cdpPort: number, key: string) {
  return cdpCall(provider, instanceId, cdpPort, "press", [key], 20000);
}
