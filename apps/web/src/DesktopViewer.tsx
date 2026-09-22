import { useCallback, useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { Activity, Command, Database, Expand, ExternalLink, HardDrive, LockKeyhole, MonitorPlay, Play, Power, RotateCw, Square, Terminal, Unlock, Wifi } from "lucide-react";
import { api } from "./api";

type ConnectionState = "connecting" | "online" | "reconnecting" | "offline";

interface DesktopStatus {
  id: string; name: string; hostname: string; status: string; provider: string; region: string;
  vcpu: number; ramMb: number; storageGb: number; ipv4: string | null;
  image: { name: string; version: string };
  host: { id: string; name: string; provider: string } | null;
  uptimeSeconds: number; allowedActions: string[];
  controller: { controller: "agent" | "human"; holderId: string | null; holderEmail: string | null; since: string | null; expiresInSeconds: number | null };
  instance: { providerInstanceId: string; status: string; ipv4?: string; uptimeSeconds?: number } | null;
  desktop: { available: boolean; width?: number; height?: number; browserRunning?: boolean; browser?: string | null; pages?: { url: string; title: string }[]; transport?: string; reason?: string };
  metrics: {
    observedAt: string; cpuPercent: number | null;
    memoryUsedBytes: string | null; memoryTotalBytes: string | null;
    diskUsedBytes: string | null; diskTotalBytes: string | null;
    networkRxBytes: string | null; networkTxBytes: string | null; uptimeSeconds: string | null;
  } | null;
}

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

// The live desktop is streamed with noVNC over an authenticated WebSocket on this same origin.
function desktopSocketUrl(id: string) {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/v1/computers/${id}/desktop`;
}

const connectionLabel: Record<ConnectionState, string> = { connecting: "Connecting", online: "Online", reconnecting: "Reconnecting", offline: "Offline" };

export function DesktopViewer({ id }: { id: string }) {
  const screenRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const attempts = useRef(0);
  const connectRef = useRef<() => void>(() => undefined);

  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [browserUrl, setBrowserUrl] = useState("https://example.com");
  const [command, setCommand] = useState("whoami && pwd");
  const [consoleResult, setConsoleResult] = useState<{ exitCode: number; output: string } | null>(null);
  const [fullScreen, setFullScreen] = useState(false);

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
    const timer = window.setInterval(() => void loadStatus(), 10000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

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
      // Give the worker a moment to apply the change before refreshing the live view.
      await new Promise(resolve => setTimeout(resolve, 2500));
      await loadStatus();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Action failed"); }
    finally { setBusy(""); }
  }, [id, loadStatus]);

  const control = useCallback(async (action: "take-control" | "release-control") => {
    setBusy(action); setError("");
    try { await api(`/computers/${id}/actions/${action}`, { method: "POST", body: "{}" }); await loadStatus(); }
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

  const humanControls = status?.controller.controller === "human";
  const metrics = status?.metrics ?? null;

  return <>
    <div className="desktop-head">
      <div>
        <div className="desktop-state">
          <span className={`status ${(status?.status ?? "offline").toLowerCase()}`}><i />{(status?.status ?? "LOADING").replaceAll("_", " ")}</span>
          <span className={`conn conn-${connection}`}><i />Desktop {connectionLabel[connection]}</span>
          <span className={`conn ${humanControls ? "conn-human" : "conn-agent"}`}><i />{humanControls ? `Human control${status?.controller.holderEmail ? ` (${status.controller.holderEmail})` : ""}` : "Agent control"}</span>
        </div>
        <p className="desktop-sub">{status?.hostname ?? id} · {status?.provider ?? "—"} · {status?.region ?? "—"}{status?.host ? ` · host ${status.host.name}` : ""}</p>
      </div>
      <div className="desktop-actions">
        <button className={humanControls ? "secondary" : "primary"} disabled={busy !== "" || !running} onClick={() => void control(humanControls ? "release-control" : "take-control")}>
          {humanControls ? <><Unlock size={15} />Release Control</> : <><LockKeyhole size={15} />Take Control</>}
        </button>
        <button className="secondary" disabled={busy !== ""} onClick={() => void lifecycle("restart")}><RotateCw size={15} />Restart</button>
        {running
          ? <button className="secondary" disabled={busy !== ""} onClick={() => void lifecycle("stop")}><Square size={15} />Stop</button>
          : <button className="primary" disabled={busy !== "" || !status} onClick={() => void lifecycle("start")}><Play size={15} />Start</button>}
        <button className="secondary" disabled={!running} onClick={() => { attempts.current = 0; connect(); }}><Wifi size={15} />Reconnect</button>
        <button className="secondary" disabled={!running} onClick={() => rfbRef.current?.sendCtrlAltDel()}><Power size={15} />Ctrl+Alt+Del</button>
        <button className="secondary" onClick={() => void toggleFullScreen()}><Expand size={15} />Full Screen</button>
      </div>
    </div>

    {error && <Notice>{error}</Notice>}
    {notice && <Notice>{notice}</Notice>}

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
        <Info label="Network received" value={metrics ? bytes(metrics.networkRxBytes) : "collecting…"} />
        <Info label="Network sent" value={metrics ? bytes(metrics.networkTxBytes) : "collecting…"} />
        <Info label="Image" value={status ? `${status.image.name} ${status.image.version}` : "—"} />
        <Info label="Metrics sampled" value={metrics ? new Date(metrics.observedAt).toLocaleTimeString() : "collecting…"} />
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
