import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { Activity, Bot, Command, Database, Expand, ExternalLink, HardDrive, LockKeyhole, LogIn, Minimize, MonitorPlay, Play, Power, RotateCw, Square, Terminal, Unlock, Wifi } from "lucide-react";
import { api } from "./api";

type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";
type Severity = "info" | "success" | "warn" | "error";

interface ActivityEvent { id: string; computerId: string; agentRunId: string | null; kind: string; message: string; severity: string; metadata: unknown; createdAt: string; }

interface AgentSession {
  computerId: string;
  controller: "agent" | "human";
  holderId: string | null; holderEmail: string | null; since: string | null; expiresInSeconds: number | null;
  session: { attached: boolean; agentRunId: string | null; agentName: string | null; status: string | null; phase: string | null; waitingForHuman: boolean; title: string | null };
}

interface DesktopStatus {
  id: string; name: string; hostname: string; status: string; provider: string; region: string;
  vcpu: number; ramMb: number; storageGb: number; ipv4: string | null;
  image: { name: string; version: string };
  host: { id: string; name: string; provider: string } | null;
  uptimeSeconds: number; allowedActions: string[];
  controller: { controller: "agent" | "human"; holderId: string | null; holderEmail: string | null; since: string | null; expiresInSeconds: number | null };
  agent?: AgentSession;
  instance: { providerInstanceId: string; status: string; ipv4?: string; uptimeSeconds?: number } | null;
  desktop: { available: boolean; width?: number; height?: number; browserRunning?: boolean; browser?: string | null; pages?: { url: string; title: string }[]; transport?: string; reason?: string };
  metrics: {
    observedAt: string; cpuPercent: number | null;
    memoryUsedBytes: string | null; memoryTotalBytes: string | null;
    diskUsedBytes: string | null; diskTotalBytes: string | null;
    networkRxBytes: string | null; networkTxBytes: string | null; uptimeSeconds: string | null;
  } | null;
}

interface Recipe { id: string; title: string; description: string; }

const gb = (value: string | null | undefined, digits = 2) => (value == null ? "—" : `${(Number(value) / 1073741824).toFixed(digits)} GB`);
const bytes = (value: string | null | undefined) => {
  if (value == null) return "—";
  const size = Number(value);
  if (size >= 1073741824) return `${(size / 1073741824).toFixed(2)} GB`;
  if (size >= 1048576) return `${(size / 1048576).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
};
const percent = (value: number | null | undefined) => (value == null ? "—" : `${value.toFixed(1)}%`);
function duration(seconds: number | null | undefined) {
  if (seconds == null) return "—";
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
const clock = (value: string) => new Date(value).toLocaleTimeString();

// The live desktop is streamed with noVNC over an authenticated WebSocket on this same origin.
function desktopSocketUrl(id: string) {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/v1/computers/${id}/desktop`;
}

// The live activity panel tails the same authenticated event channel the API already exposes.
function activitySocketUrl(id: string) {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/v1/events?computerId=${id}`;
}

const connectionLabel: Record<ConnectionState, string> = { connecting: "Connecting", online: "Online", reconnecting: "Reconnecting", offline: "Offline" };
const MAX_ACTIVITY = 200;

export function DesktopViewer({ id }: { id: string }) {
  const screenRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const activityTimer = useRef<number | null>(null);
  const attempts = useRef(0);
  const connectRef = useRef<() => void>(() => undefined);
  const activityFeedRef = useRef<HTMLDivElement | null>(null);

  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [browserUrl, setBrowserUrl] = useState("https://example.com");
  const [command, setCommand] = useState("whoami && pwd");
  const [consoleResult, setConsoleResult] = useState<{ exitCode: number; output: string } | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [activityLive, setActivityLive] = useState(false);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [task, setTask] = useState("Open GitHub and check my repository");
  const [recipe, setRecipe] = useState("auto");

  const loadStatus = useCallback(async () => {
    try {
      const next = await api<DesktopStatus>(`/computers/${id}/status`);
      setStatus(next);
      setError("");
      return next;
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Status unavailable"); return null; }
  }, [id]);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 8000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  // Activity history, then the live tail over the authenticated event socket.
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    const merge = (incoming: ActivityEvent[]) => setEvents(current => {
      const seen = new Set(current.map(event => event.id));
      const merged = [...current];
      for (const event of incoming) if (!seen.has(event.id)) { merged.push(event); seen.add(event.id); }
      merged.sort((a, b) => Number(a.id) - Number(b.id));
      return merged.length > MAX_ACTIVITY ? merged.slice(merged.length - MAX_ACTIVITY) : merged;
    });
    api<{ data: ActivityEvent[] }>(`/computers/${id}/activity?limit=60`).then(result => { if (!disposed) merge(result.data); }).catch(() => undefined);

    const open = () => {
      if (disposed) return;
      try { socket = new WebSocket(activitySocketUrl(id)); }
      catch { return; }
      socket.onopen = () => setActivityLive(true);
      socket.onclose = () => {
        setActivityLive(false);
        if (!disposed) { activityTimer.current = window.setTimeout(open, 4000); }
      };
      socket.onerror = () => setActivityLive(false);
      socket.onmessage = message => {
        try {
          const payload = JSON.parse(message.data as string) as { type?: string; event?: ActivityEvent };
          if (payload.type === "activity" && payload.event) merge([payload.event]);
        } catch { /* heartbeat or unrelated frame */ }
      };
    };
    open();
    return () => {
      disposed = true;
      if (activityTimer.current) window.clearTimeout(activityTimer.current);
      activityTimer.current = null;
      try { socket?.close(); } catch { /* already closed */ }
    };
  }, [id]);

  useEffect(() => {
    api<{ data: Recipe[] }>("/agent/recipes").then(result => setRecipes(result.data)).catch(() => undefined);
  }, []);

  useEffect(() => {
    const feed = activityFeedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, [events.length]);

  const disconnect = useCallback(() => {
    if (reconnectTimer.current) { window.clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    const rfb = rfbRef.current;
    rfbRef.current = null;
    if (rfb) { try { rfb.disconnect(); } catch { /* already closed */ } }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimer.current) return;
    const delay = Math.min(15000, 1500 * Math.max(1, attempts.current));
    attempts.current += 1;
    reconnectTimer.current = window.setTimeout(() => { reconnectTimer.current = null; connectRef.current(); }, delay);
  }, []);

  const connect = useCallback(() => {
    const target = screenRef.current;
    if (!target) return;
    disconnect();
    target.innerHTML = "";
    setConnection("connecting");
    let rfb: RFB;
    try { rfb = new RFB(target, desktopSocketUrl(id)); }
    catch (caught) { setConnection("offline"); setNotice(caught instanceof Error ? caught.message : "The desktop stream could not be opened"); return; }
    rfbRef.current = rfb;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.clipViewport = false;
    rfb.background = "#05070a";
    rfb.addEventListener("connect", () => { attempts.current = 0; setConnection("online"); setNotice(""); });
    rfb.addEventListener("disconnect", event => {
      if (rfbRef.current !== rfb) return;
      rfbRef.current = null;
      setConnection("reconnecting");
      setNotice(event?.detail?.clean ? "Desktop stream closed." : `Desktop stream interrupted${event?.detail?.reason ? `: ${event.detail.reason}` : "."}`);
      scheduleReconnect();
    });
    rfb.addEventListener("securityfailure", event => { setConnection("offline"); setNotice(`The desktop refused the connection${event?.detail?.reason ? `: ${event.detail.reason}` : "."}`); });
    rfb.addEventListener("credentialsrequired", () => { setConnection("offline"); setNotice("The desktop unexpectedly requested credentials."); });
  }, [disconnect, id, scheduleReconnect]);

  useEffect(() => { connectRef.current = connect; }, [connect]);

  const running = status?.status === "RUNNING";

  useEffect(() => {
    if (!running) { disconnect(); setConnection("offline"); return; }
    connect();
    return () => disconnect();
  }, [running, connect, disconnect]);

  useEffect(() => {
    const changed = () => setFullScreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  const lifecycle = useCallback(async (action: string) => {
    setBusy(action); setError("");
    try {
      await api(`/computers/${id}/${action}`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } });
      await new Promise(resolve => setTimeout(resolve, 2500));
      await loadStatus();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Action failed"); }
    finally { setBusy(""); }
  }, [id, loadStatus]);

  // Control changes go through the controller endpoints so they show up on the live stream.
  const control = useCallback(async (action: "request" | "release") => {
    setBusy(action); setError("");
    try {
      await api(`/computers/${id}/controller/${action}`, { method: "POST", body: JSON.stringify({ reason: action === "request" ? "Operator took the desktop" : undefined }) });
      await loadStatus();
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Control action failed"); }
    finally { setBusy(""); }
  }, [id, loadStatus]);

  const openBrowser = useCallback(async () => {
    setBusy("browser"); setError("");
    try { await api(`/computers/${id}/actions/browser/navigate`, { method: "POST", body: JSON.stringify({ url: browserUrl }) }); await loadStatus(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open the browser"); }
    finally { setBusy(""); }
  }, [browserUrl, id, loadStatus]);

  const openVisibleBrowserTab = useCallback(async () => {
    setBusy("browser-tab"); setError("");
    try { await api(`/computers/${id}/actions/browser/open`, { method: "POST", body: JSON.stringify({ url: browserUrl }) }); await loadStatus(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open a browser tab"); }
    finally { setBusy(""); }
  }, [browserUrl, id, loadStatus]);

  const openDesktopTerminal = useCallback(async () => {
    setBusy("terminal"); setError("");
    try { await api(`/computers/${id}/actions/terminal`, { method: "POST", body: JSON.stringify({ visible: true }) }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open a terminal"); }
    finally { setBusy(""); }
  }, [id]);

  const runCommand = useCallback(async () => {
    setBusy("command"); setError("");
    try {
      const result = await api<{ execution: { exitCode: number; stdout: string; stderr: string } }>(`/computers/${id}/actions/terminal`, { method: "POST", body: JSON.stringify({ command }) });
      setConsoleResult({ exitCode: result.execution.exitCode, output: `${result.execution.stdout}${result.execution.stderr}` });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Command failed"); }
    finally { setBusy(""); }
  }, [command, id]);

  const toggleFullScreen = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage) return;
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await stage.requestFullscreen(); }
    catch { setError("This browser blocked full screen mode"); }
  }, []);

  // "Use with Agent": start a task on THIS computer — same id, same visible desktop.
  const startAgentTask = useCallback(async () => {
    setBusy("agent"); setError("");
    try {
      const payload: Record<string, unknown> = { instruction: task, start: true };
      if (recipe !== "auto") payload.recipe = recipe;
      await api(`/computers/${id}/attach`, { method: "POST", body: JSON.stringify(payload) });
      await loadStatus();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not start the agent task"); }
    finally { setBusy(""); }
  }, [id, loadStatus, recipe, task]);

  const detachAgent = useCallback(async () => {
    setBusy("detach"); setError("");
    try { await api(`/computers/${id}/detach`, { method: "POST", body: JSON.stringify({}) }); await loadStatus(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not detach the agent"); }
    finally { setBusy(""); }
  }, [id, loadStatus]);

  const humanControls = status?.controller.controller === "human";
  const metrics = status?.metrics ?? null;
  const agentSession = status?.agent?.session ?? null;
  const agentWaiting = agentSession?.waitingForHuman ?? false;
  const agentBusy = Boolean(agentSession?.attached);
  const orderedEvents = useMemo(() => events.slice(-MAX_ACTIVITY), [events]);

  return <>
    <div className="desktop-head">
      <div>
        <div className="desktop-state">
          <span className={`status ${(status?.status ?? "offline").toLowerCase()}`}><i />{(status?.status ?? "LOADING").replaceAll("_", " ")}</span>
          <span className={`conn conn-${connection}`}><i />Desktop {connectionLabel[connection]}</span>
          <span className={`conn ${humanControls ? "conn-human" : "conn-agent"}`}><i />{humanControls ? `Human control${status?.controller.holderEmail ? ` (${status.controller.holderEmail})` : ""}` : "Agent control"}</span>
          {agentSession?.attached && <span className={`conn conn-${agentWaiting ? "human" : "agent"}`}><Bot size={13} />{agentWaiting ? "Agent paused — login required" : `Agent ${agentSession.status ?? "attached"}`}</span>}
        </div>
        <p className="desktop-sub">{status?.hostname ?? id} · {status?.provider ?? "—"} · {status?.region ?? "—"}{status?.host ? ` · host ${status.host.name}` : ""}</p>
      </div>
      <div className="desktop-actions">
        <button className={humanControls ? "secondary" : "primary"} disabled={busy !== "" || !running} onClick={() => void control(humanControls ? "release" : "request")}>
          {humanControls ? <><Unlock size={15} />Release Control</> : <><LockKeyhole size={15} />Take Control</>}
        </button>
        <button className="secondary" disabled={busy !== ""} onClick={() => void lifecycle("restart")}><RotateCw size={15} />Restart</button>
        {running
          ? <button className="secondary" disabled={busy !== ""} onClick={() => void lifecycle("stop")}><Square size={15} />Stop</button>
          : <button className="primary" disabled={busy !== "" || !status} onClick={() => void lifecycle("start")}><Play size={15} />Start</button>}
        <button className="secondary" disabled={!running} onClick={() => { attempts.current = 0; connect(); }}><Wifi size={15} />Reconnect</button>
        <button className="secondary" disabled={!running} onClick={() => rfbRef.current?.sendCtrlAltDel()}><Power size={15} />Ctrl+Alt+Del</button>
        <button className="secondary" onClick={() => void toggleFullScreen()}>{fullScreen ? <><Minimize size={15} />Exit Full Screen</> : <><Expand size={15} />Full Screen</>}</button>
      </div>
    </div>

    {error && <Notice>{error}</Notice>}
    {notice && <Notice>{notice}</Notice>}
    {agentWaiting && <div className="notice waiting">
      <LogIn size={16} />
      <span><b>Agent paused — login required.</b> {agentSession?.phase ? `${agentSession.phase}. ` : ""}Click <b>Take Control</b>, sign in yourself on the desktop, then click <b>Release Control</b>. The agent never asks for your password over chat.</span>
    </div>}

    <div className="desktop-layout">
      <div className={`desktop-stage${fullScreen ? " fullscreen" : ""}`} ref={stageRef}>
        <div className="desktop-screen" ref={screenRef} />
        {!running && <div className="desktop-overlay">
          <MonitorPlay size={38} />
          <h3>{status ? `The AI Computer is ${status.status.replaceAll("_", " ")}` : "Loading the AI Computer"}</h3>
          <p>{status?.desktop.reason ?? "Start the computer to open its live desktop."}</p>
          {status && status.allowedActions.includes("start") && <button className="primary" onClick={() => void lifecycle("start")}><Play size={16} />Start computer</button>}
        </div>}
        {running && connection !== "online" && <div className="desktop-overlay soft">
          <Wifi size={30} />
          <h3>Desktop {connectionLabel[connection]}</h3>
          <p>{notice || "Establishing the authenticated desktop stream…"}</p>
        </div>}
        {fullScreen && <button className="fullscreen-exit secondary" onClick={() => void toggleFullScreen()}><Minimize size={15} />Exit Full Screen</button>}
      </div>

      <aside className="activity-panel">
        <div className="activity-head">
          <div><Activity size={15} /><b>Live activity</b></div>
          <span className={activityLive ? "live" : "live off"}>{activityLive ? "live" : "reconnecting"}</span>
        </div>
        <div className="activity-feed" ref={activityFeedRef}>
          {orderedEvents.length === 0
            ? <p className="activity-empty">Nothing yet. Agent and operator actions appear here as they happen.</p>
            : orderedEvents.map(event => <div key={event.id} className={`activity-row sev-${event.severity}`}>
              <span className="activity-time">{clock(event.createdAt)}</span>
              <span className="activity-dot" />
              <span className="activity-message">{event.message}</span>
            </div>)}
        </div>
        <div className="activity-agent">
          <div className="activity-head small"><div><Bot size={14} /><b>Use with Agent</b></div>{agentBusy && <span className="agent-state">{agentSession?.status}</span>}</div>
          <label className="bar-field">
            <span>Task</span>
            <textarea rows={2} value={task} onChange={event => setTask(event.target.value)} placeholder="Open GitHub and check my repository" />
          </label>
          <label className="bar-field">
            <span>Recipe</span>
            <select value={recipe} onChange={event => setRecipe(event.target.value)}>
              <option value="auto">Choose automatically from the task</option>
              {recipes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
          <div className="activity-actions">
            <button className="primary" disabled={busy !== "" || !running || agentBusy} onClick={() => void startAgentTask()}><Bot size={15} />Start agent on this computer</button>
            <button className="secondary" disabled={busy !== "" || !agentBusy} onClick={() => void detachAgent()}>Detach</button>
          </div>
          {agentSession?.phase && <p className="activity-phase">{agentSession.agentName ?? "Agent"} · {agentSession.phase}</p>}
        </div>
      </aside>
    </div>

    <div className="desktop-bar">
      <label className="bar-field">
        <span>Browser URL</span>
        <input value={browserUrl} onChange={event => setBrowserUrl(event.target.value)} />
      </label>
      <button className="secondary" disabled={busy !== "" || !running} onClick={() => void openBrowser()}><ExternalLink size={15} />Open Browser</button>
      <button className="secondary" disabled={busy !== "" || !running} onClick={() => void openVisibleBrowserTab()}><MonitorPlay size={15} />New Tab</button>
      <button className="secondary" disabled={busy !== "" || !running} onClick={() => void openDesktopTerminal()}><Terminal size={15} />Open Terminal</button>
    </div>

    <div className="stats desktop-stats">
      <Stat label="CPU" value={percent(metrics?.cpuPercent)} icon={Activity} />
      <Stat label="Memory" value={metrics ? `${gb(metrics.memoryUsedBytes, 2)} / ${gb(metrics.memoryTotalBytes, 0)}` : "collecting…"} icon={Database} />
      <Stat label="Disk (persistent home)" value={metrics ? `${gb(metrics.diskUsedBytes, 2)} used of ${gb(metrics.diskTotalBytes, 0)}` : "collecting…"} icon={HardDrive} />
      <Stat label="Uptime" value={duration(status?.uptimeSeconds)} icon={RotateCw} />
    </div>

    <section>
      <div className="section-head"><h2>Computer</h2><span>{status?.desktop.transport ?? ""}</span></div>
      <div className="info-grid">
        <Info label="ID" value={status?.id ?? id} mono />
        <Info label="Name" value={status?.name ?? "—"} />
        <Info label="Provider" value={status?.provider ?? "—"} />
        <Info label="Container" value={status?.instance?.providerInstanceId ? status.instance.providerInstanceId.slice(0, 12) : "—"} mono />
        <Info label="CPU / RAM / Disk" value={status ? `${status.vcpu} vCPU · ${(status.ramMb / 1024).toFixed(0)} GB · ${status.storageGb} GB` : "—"} />
        <Info label="IP address (internal)" value={status?.ipv4 ?? "—"} mono />
        <Info label="Desktop resolution" value={status?.desktop.width ? `${status.desktop.width}×${status.desktop.height}` : "—"} />
        <Info label="Browser" value={status?.desktop.browser ? `${status.desktop.browser}${status.desktop.browserRunning ? "" : " (not running)"}` : "—"} />
        <Info label="Agent session" value={agentSession?.attached ? `${agentSession.agentName ?? "agent"} · ${agentSession.status}` : "not attached"} />
        <Info label="Network received" value={metrics ? bytes(metrics.networkRxBytes) : "collecting…"} />
        <Info label="Network sent" value={metrics ? bytes(metrics.networkTxBytes) : "collecting…"} />
        <Info label="Image" value={status ? `${status.image.name} ${status.image.version}` : "—"} />
      </div>
      {status?.desktop.pages?.length ? <div className="page-list">
        <span className="page-list-title">Visible browser tabs</span>
        {status.desktop.pages.map(page => <div key={page.url} className="page-row"><ExternalLink size={13} /><b>{page.title || page.url}</b><small>{page.url}</small></div>)}
      </div> : null}
    </section>

    <section>
      <div className="section-head"><h2>Terminal</h2><span>Runs inside the computer as the unprivileged agent user</span></div>
      <div className="console-form">
        <input value={command} onChange={event => setCommand(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void runCommand(); }} placeholder="Command to run inside the AI Computer" />
        <button className="primary" disabled={busy !== "" || !running} onClick={() => void runCommand()}><Command size={15} />Run</button>
      </div>
      {consoleResult && <pre className="terminal-output">exit {consoleResult.exitCode}{"\n"}{consoleResult.output}</pre>}
    </section>
  </>;
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="info"><span>{label}</span><b className={mono ? "mono" : ""}>{value}</b></div>;
}

function Stat({ label, value, icon: Icon }: { label: string; value: string; icon: any }) {
  return <div className="stat"><div><span>{label}</span><strong>{value}</strong></div><Icon size={21} /></div>;
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="notice">{children}</div>;
}

export type { Severity };
