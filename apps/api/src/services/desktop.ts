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
  click: (x: number, y: number, button: number, clicks: number) => ["mousemove", "--sync", String(x), String(y), "click", "--repeat", String(clicks), "--delay", "40", String(button)],
  type: (text: string, delayMs: number) => ["type", "--clearmodifiers", "--delay", String(delayMs), "--", text],
  keypress: (keys: string) => ["key", "--clearmodifiers", keys],
  scroll: (x: number, y: number, button: number, amount: number) => ["mousemove", "--sync", String(x), String(y), "click", "--repeat", String(amount), "--delay", "40", String(button)]
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

export interface SocketLike { binaryType?: string; readyState: number; send(data: unknown): void; close(code?: number, reason?: string): void; addEventListener(type: string, listener: (event: { data?: unknown }) => void): void; }

export function openWebSocket(url: string, protocols?: string[]): SocketLike {
  const Ctor = (globalThis as unknown as { WebSocket?: new (target: string, protocols?: string[]) => SocketLike }).WebSocket;
  if (typeof Ctor !== "function") throw new ProviderError("CAPABILITY_UNSUPPORTED", "This Node.js runtime does not provide a WebSocket client");
  return protocols ? new Ctor(url, protocols) : new Ctor(url);
}

export interface CdpPage { id: string; url: string; title: string; }
export interface BrowserState { browser: string | null; pages: CdpPage[]; }

// Chromium runs headful on the XFCE desktop and also exposes the DevTools protocol, so browser
// work is done over the real protocol against that same visible window instead of a separate
// headless browser.
//
// Chrome refuses to bind its DevTools endpoint to anything but loopback, so the control plane
// cannot talk to it across the container network. It therefore drives the protocol over the
// container's own loopback with the Node.js runtime that ships in the image: Node's built-in
// WebSocket speaks CDP, and no shell is involved anywhere in this path.
const CDP_CLIENT = [
  "(async()=>{",
  "const [mode,port,arg]=process.argv.slice(1);",
  'const base="http://127.0.0.1:"+port;',
  'const json=async(path,method="GET")=>{const r=await fetch(base+path,{method});return r.ok?r.json():null;};',
  'if(mode==="list"){const v=await json("/json/version");const l=(await json("/json/list"))||[];console.log(JSON.stringify({browser:v&&v.Browser,pages:l.filter(t=>t.type==="page").map(t=>({id:t.id,url:t.url,title:t.title}))}));return;}',
  'if(mode==="newtab"){const c=await json("/json/new?"+encodeURIComponent(arg),"PUT");console.log(JSON.stringify({opened:Boolean(c),id:c&&c.id}));return;}',
  'if(mode==="close"){await json("/json/close/"+arg);console.log(JSON.stringify({closed:arg}));return;}',
  'const l=(await json("/json/list"))||[];const page=l.find(t=>t.type==="page");',
  'if(!page)throw new Error("no page target is available");',
  "const ws=new WebSocket(page.webSocketDebuggerUrl);",
  'await new Promise((r,j)=>{ws.onopen=r;ws.onerror=()=>j(new Error("devtools socket failed"));});',
  'const res=await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error("devtools call timed out")),20000);ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(t);r(m);}};ws.send(JSON.stringify({id:1,method:"Page.navigate",params:{url:arg}}));});',
  "ws.close();",
  'if(res.error)throw new Error(res.error.message||"navigation failed");',
  "console.log(JSON.stringify({navigated:true,url:arg}));",
  '})().catch(e=>{console.error("CDP_ERROR "+e.message);process.exit(1);})'
].join("");

async function cdpClient(provider: VirtualizationProvider, instanceId: string, cdpPort: number, mode: string, argument?: string, timeoutMs = 30000) {
  const args = ["-e", CDP_CLIENT, mode, String(cdpPort)];
  if (argument !== undefined) args.push(argument);
  return run(provider, instanceId, "/usr/bin/node", args, { timeoutMs, outputLimitBytes: 262144 });
}

export async function browserState(provider: VirtualizationProvider, instanceId: string, cdpPort: number): Promise<BrowserState | null> {
  try {
    const result = await cdpClient(provider, instanceId, cdpPort, "list", undefined, 20000);
    if (result.exitCode !== 0) return null;
    const parsed = JSON.parse(result.stdout.trim()) as BrowserState;
    return { browser: parsed.browser ?? null, pages: Array.isArray(parsed.pages) ? parsed.pages : [] };
  } catch { return null; }
}

export async function browserOpenTab(provider: VirtualizationProvider, instanceId: string, cdpPort: number, url: string): Promise<boolean> {
  try {
    const result = await cdpClient(provider, instanceId, cdpPort, "newtab", url, 30000);
    if (result.exitCode !== 0) return false;
    return (JSON.parse(result.stdout.trim()) as { opened?: boolean }).opened === true;
  } catch { return false; }
}

export async function browserNavigate(provider: VirtualizationProvider, instanceId: string, cdpPort: number, url: string): Promise<boolean> {
  try {
    const result = await cdpClient(provider, instanceId, cdpPort, "navigate", url, 45000);
    if (result.exitCode !== 0) return false;
    return (JSON.parse(result.stdout.trim()) as { navigated?: boolean }).navigated === true;
  } catch { return false; }
}
