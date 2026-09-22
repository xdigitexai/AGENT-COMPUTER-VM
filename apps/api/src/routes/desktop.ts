import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireScope } from "../auth.js";
import { allowedActions } from "../domain/state-machine.js";
import { providerFor } from "../providers/factory.js";
import { ProviderError, type VirtualizationProvider } from "../providers/types.js";
import type { Config } from "../config.js";
import type { ControlLock } from "../services/control.js";
import type { ActivityHub } from "../services/activity.js";
import { activeRunFor, controllerSnapshot } from "../services/agent.js";
import { browserNavigate, browserOpenTab, browserState, captureScreenshot, displayGeometry, inputCommands, openWebSocket, redactUrl, run, type SocketLike } from "../services/desktop.js";

const computerId = z.object({ id: z.string().uuid() });
const coordinate = z.number().int().min(0).max(16384);

interface DesktopEndpoint { ipv4: string | null; port: number; cdpPort: number; websockifyUrl: string; }

// The subset of a Computer row these routes need. Declared structurally so the Prisma result
// type does not leak into every helper signature.
interface Target {
  computer: { id: string; name: string; hostname: string; status: string; provider: string; region: string; vcpu: number; ramMb: number; storageGb: number; providerInstanceId: string; ipv4: string | null };
  provider: VirtualizationProvider;
}

export function desktopRoutes(config: Config, control: ControlLock, activity: ActivityHub) {
  return async (app: FastifyInstance) => {
    const scope = { console: requireScope("computer:console"), agent: requireScope("computer:agent"), read: requireScope("computer:read") };

    // Desktop actions performed from the console are part of the same live activity story the
    // agent writes to, so an operator can see what is happening beside the desktop.
    const announce = async (req: FastifyRequest, id: string, kind: string, message: string, severity: "info" | "success" | "warn" | "error" = "info", metadata: Record<string, unknown> = {}) => {
      const run = await activeRunFor(id);
      await activity.tryRecord(prisma, { computerId: id, organizationId: req.auth!.organizationId, agentRunId: run?.id ?? null, kind, message, severity, metadata });
    };

    // Ownership is enforced here for every desktop action: only computers that belong to the
    // caller's organization are ever resolved, and a computer owned by somebody else is
    // indistinguishable from one that does not exist.
    async function resolve(req: FastifyRequest, reply: FastifyReply, id: string): Promise<Target | null> {
      const computer = await prisma.computer.findFirst({ where: { id, organizationId: req.auth!.organizationId, deletedAt: null }, include: { host: { include: { credential: true } } } });
      if (!computer || !computer.host || !computer.providerInstanceId) {
        await reply.code(404).send({ error: { code: "NOT_FOUND", message: "AI Computer is not available" } });
        return null;
      }
      let provider: VirtualizationProvider;
      try { provider = providerFor(computer.host, config); }
      catch (error) {
        await reply.code(409).send({ error: { code: error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE", message: error instanceof Error ? error.message : "Provider unavailable" } });
        return null;
      }
      return { computer: { ...computer, providerInstanceId: computer.providerInstanceId }, provider };
    }

    // Shared-control enforcement. A human operator holds the lock; while they do, input from an
    // API key (the agent) is rejected by the server, not merely hidden in the interface.
    async function gate(req: FastifyRequest, reply: FastifyReply, id: string) {
      const state = await control.get(id);
      if (state.controller !== "human") return state;
      const isHolder = !req.auth!.agent && state.holderId === req.auth!.userId;
      if (isHolder) return state;
      await reply.code(409).send({ error: { code: "CONTROLLER_BUSY", message: "A human operator holds control of this AI Computer, so agent input is paused. Release control to let the agent resume.", controller: state.controller, holderId: state.holderId } });
      return null;
    }

    async function audit(req: FastifyRequest, computerIdValue: string, action: string, metadata: Record<string, unknown> = {}) {
      await prisma.auditLog.create({ data: { actorId: req.auth!.userId, organizationId: req.auth!.organizationId, action, resourceType: "Computer", resourceId: computerIdValue, ipAddress: req.ip, metadata: metadata as object } });
    }

    async function desktopEndpointOf(provider: VirtualizationProvider, instanceId: string): Promise<DesktopEndpoint | null> {
      if (!provider.getDesktopEndpoint) return null;
      try { return await provider.getDesktopEndpoint(instanceId); } catch { return null; }
    }

    // `gated` marks the actions that count as agent input: while a human operator holds control
    // these are refused by the server. Observation (screenshot/status) stays available.
    function actionHandler(gated: boolean, handler: (target: Target, req: FastifyRequest, reply: FastifyReply, id: string) => Promise<unknown>) {
      return async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = computerId.parse(req.params);
        const target = await resolve(req, reply, id);
        if (!target) return;
        if (gated) { const state = await gate(req, reply, id); if (!state) return; }
        if (target.computer.status !== "RUNNING") return reply.code(409).send({ error: { code: "NOT_RUNNING", message: `The AI Computer is ${target.computer.status}; start it before sending desktop actions` } });
        return handler(target, req, reply, id);
      };
    }

    async function launchVisibleTerminal(target: Target) {
      // Constants only: the shell is used to detach the terminal from this exec's output pipe.
      return run(target.provider, target.computer.providerInstanceId, "/bin/bash", ["-lc", "setsid -f /usr/bin/xfce4-terminal --disable-server --working-directory=/home/agent >/dev/null 2>&1 </dev/null"], { timeoutMs: 15000, outputLimitBytes: 8192 });
    }

    app.post("/:id/actions/click", { preHandler: scope.agent }, actionHandler(true, async (target, req, _reply, id) => {
      const input = z.object({ x: coordinate, y: coordinate, button: z.number().int().min(1).max(5).default(1), clicks: z.number().int().min(1).max(5).default(1) }).parse(req.body);
      const execution = await run(target.provider, target.computer.providerInstanceId, "/usr/bin/xdotool", inputCommands.click(input.x, input.y, input.button, input.clicks));
      await audit(req, id, "computer.action.click", { x: input.x, y: input.y, button: input.button, clicks: input.clicks, exitCode: execution.exitCode });
      return { action: "click", input, execution };
    }));

    app.post("/:id/actions/type", { preHandler: scope.agent }, actionHandler(true, async (target, req, _reply, id) => {
      const input = z.object({ text: z.string().min(1).max(4000), delayMs: z.number().int().min(0).max(500).default(25) }).parse(req.body);
      const execution = await run(target.provider, target.computer.providerInstanceId, "/usr/bin/xdotool", inputCommands.type(input.text, input.delayMs), { timeoutMs: 60000 });
      // The typed characters are deliberately not audited: they may contain secrets.
      await audit(req, id, "computer.action.type", { length: input.text.length, exitCode: execution.exitCode });
      return { action: "type", input: { length: input.text.length, delayMs: input.delayMs }, execution: { ...execution, stdout: "" } };
    }));

    app.post("/:id/actions/keypress", { preHandler: scope.agent }, actionHandler(true, async (target, req, _reply, id) => {
      const input = z.object({ keys: z.string().min(1).max(120).regex(/^[A-Za-z0-9+_\-.]+( [A-Za-z0-9+_\-.]+)*$/, "Use xdotool key syntax such as ctrl+alt+t or Return") }).parse(req.body);
      const execution = await run(target.provider, target.computer.providerInstanceId, "/usr/bin/xdotool", inputCommands.keypress(input.keys));
      await audit(req, id, "computer.action.keypress", { keys: input.keys, exitCode: execution.exitCode });
      return { action: "keypress", input, execution };
    }));

    app.post("/:id/actions/scroll", { preHandler: scope.agent }, actionHandler(true, async (target, req, _reply, id) => {
      const input = z.object({ x: coordinate.default(720), y: coordinate.default(450), direction: z.enum(["up", "down"]), amount: z.number().int().min(1).max(50).default(3) }).parse(req.body);
      const button = input.direction === "up" ? 4 : 5;
      const execution = await run(target.provider, target.computer.providerInstanceId, "/usr/bin/xdotool", inputCommands.scroll(input.x, input.y, button, input.amount));
      await audit(req, id, "computer.action.scroll", { direction: input.direction, amount: input.amount, exitCode: execution.exitCode });
      return { action: "scroll", input, execution };
    }));

    app.post("/:id/actions/screenshot", { preHandler: scope.agent }, actionHandler(false, async (target, req, _reply, id) => {
      const screenshot = await captureScreenshot(target.provider, target.computer.providerInstanceId);
      await audit(req, id, "computer.action.screenshot", { path: screenshot.path, bytes: screenshot.bytes });
      return { action: "screenshot", path: screenshot.path, mimeType: screenshot.mimeType, bytes: screenshot.bytes, capturedAt: screenshot.capturedAt, imageBase64: screenshot.base64 };
    }));

    app.post("/:id/actions/terminal", { preHandler: scope.agent }, actionHandler(true, async (target, req, _reply, id) => {
      const input = z.object({ command: z.string().min(1).max(4000).optional(), visible: z.boolean().optional(), timeoutMs: z.number().int().min(1000).max(300000).default(60000) })
        .refine(value => Boolean(value.command) !== Boolean(value.visible), { message: "Provide either command or visible" }).parse(req.body);
      if (input.visible) {
        const execution = await launchVisibleTerminal(target);
        await audit(req, id, "computer.action.terminal", { mode: "visible", exitCode: execution.exitCode });
        return { action: "terminal", mode: "visible", execution };
      }
      const execution = await run(target.provider, target.computer.providerInstanceId, "/bin/bash", ["-lc", input.command as string], { timeoutMs: input.timeoutMs });
      await audit(req, id, "computer.action.terminal", { mode: "command", exitCode: execution.exitCode });
      return { action: "terminal", mode: "command", execution };
    }));

    app.post("/:id/actions/restart", { preHandler: scope.agent }, actionHandler(true, async (target, req, _reply, id) => {
      // Restarts the desktop session inside the running computer (X server, VNC, XFCE, browser).
      const execution = await run(target.provider, target.computer.providerInstanceId, "/usr/bin/touch", ["/home/agent/.xdigitex/.session-restart"], { timeoutMs: 10000 });
      await audit(req, id, "computer.action.restart_desktop", { exitCode: execution.exitCode });
      return { action: "restart", scope: "desktop-session", execution };
    }));

    app.post("/:id/actions/browser/open", { preHandler: scope.agent }, actionHandler(true, async (target, req, _reply, id) => {
      const input = z.object({ url: z.string().url().max(2048).optional() }).parse(req.body ?? {});
      const url = input.url ?? "about:blank";
      const endpoint = await desktopEndpointOf(target.provider, target.computer.providerInstanceId);
      // A visible Chromium window already exists: add the URL as another visible tab over CDP.
      const opened = endpoint ? await browserOpenTab(target.provider, target.computer.providerInstanceId, endpoint.cdpPort, url) : false;
      const method = opened ? "cdp-new-tab" : "launch";
      if (!opened) await run(target.provider, target.computer.providerInstanceId, "/usr/local/bin/xdigitex-browser", [url], { timeoutMs: 20000, outputLimitBytes: 8192 });
      await audit(req, id, "computer.action.browser_open", { url, method });
      return { action: "browser.open", url, method };
    }));

    app.post("/:id/actions/browser/navigate", { preHandler: scope.agent }, actionHandler(true, async (target, req, _reply, id) => {
      const input = z.object({ url: z.string().url().max(2048) }).parse(req.body);
      const endpoint = await desktopEndpointOf(target.provider, target.computer.providerInstanceId);
      let method = "xdotool-address-bar";
      if (endpoint && await browserNavigate(target.provider, target.computer.providerInstanceId, endpoint.cdpPort, input.url)) method = "cdp-page-navigate";
      else {
        // Fallback that still drives the visible window: focus Chromium, type the address, press Return.
        await run(target.provider, target.computer.providerInstanceId, "/usr/bin/xdotool",
          ["search", "--onlyvisible", "--class", "chromium", "windowactivate", "--sync", "key", "--clearmodifiers", "ctrl+l", "type", "--delay", "30", "--", input.url, "key", "Return"],
          { timeoutMs: 30000 });
      }
      await audit(req, id, "computer.action.browser_navigate", { url: input.url, method });
      await announce(req, id, "browser.navigate", `Navigating to ${input.url}`, "info", { method });
      return { action: "browser.navigate", url: input.url, method };
    }));

    app.post("/:id/actions/take-control", { preHandler: scope.console }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      if (req.auth!.agent) return reply.code(403).send({ error: { code: "HUMAN_REQUIRED", message: "Control can only be taken from an interactive signed-in session" } });
      const target = await resolve(req, reply, id);
      if (!target) return;
      const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true } });
      const state = await control.take(id, { userId: req.auth!.userId, email: user?.email ?? null });
      await audit(req, id, "computer.control.take", {});
      await announce(req, id, "human.took_control", `Human took control${user?.email ? ` (${user.email})` : ""}`, "warn");
      return { computerId: id, ...state };
    });

    app.post("/:id/actions/release-control", { preHandler: scope.console }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      if (req.auth!.agent) return reply.code(403).send({ error: { code: "HUMAN_REQUIRED", message: "Control can only be released from an interactive signed-in session" } });
      const target = await resolve(req, reply, id);
      if (!target) return;
      const state = await control.release(id);
      const waiting = await activeRunFor(id);
      if (waiting?.status === "WAITING_FOR_HUMAN") await prisma.agentRun.update({ where: { id: waiting.id }, data: { status: "ATTACHED", phase: "Human control released" } });
      await audit(req, id, "computer.control.release", {});
      await announce(req, id, "human.control_released", "Human released control", "info", { heldFor: null });
      await announce(req, id, "HUMAN_CONTROL_RELEASED", "Agent resumed — HUMAN_CONTROL_RELEASED", "success");
      return { computerId: id, ...state };
    });

    app.get("/:id/status", { preHandler: scope.read }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      const computer = await prisma.computer.findFirst({ where: { id, organizationId: req.auth!.organizationId, deletedAt: null }, include: { image: true, host: { include: { credential: true } } } });
      if (!computer) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Computer not found" } });
      const state = await control.get(id);
      const desktop: { available: boolean; width?: number; height?: number; browserRunning?: boolean; browser?: string | null; pages?: { url: string; title: string }[]; transport?: string; reason?: string } = { available: false, transport: "noVNC over authenticated HTTPS/WebSocket (wss)" };
      let instance: { providerInstanceId: string; status: string; ipv4?: string; uptimeSeconds?: number } | null = null;
      if (computer.host && computer.providerInstanceId) {
        try {
          const provider = providerFor(computer.host, config);
          const inspected = await provider.getComputer(computer.providerInstanceId);
          if (inspected) {
            instance = { providerInstanceId: inspected.providerInstanceId, status: inspected.status, ipv4: inspected.ipv4, uptimeSeconds: inspected.uptimeSeconds };
            if (inspected.status === "RUNNING") {
              const geometry = await displayGeometry(provider, computer.providerInstanceId);
              const endpoint = await desktopEndpointOf(provider, computer.providerInstanceId);
              const browser = endpoint ? await browserState(provider, computer.providerInstanceId, endpoint.cdpPort) : null;
              desktop.available = Boolean(geometry);
              desktop.width = geometry?.width;
              desktop.height = geometry?.height;
              desktop.browserRunning = Boolean(browser);
              desktop.browser = browser?.browser ?? null;
              desktop.pages = browser?.pages.map(page => ({ url: redactUrl(page.url), title: page.title }));
              if (!geometry) desktop.reason = "The desktop session has not reported a display geometry yet";
            } else desktop.reason = `The AI Computer is ${inspected.status}`;
          }
        } catch (error) { desktop.reason = error instanceof Error ? error.message : "Provider inspection failed"; }
      }
      const latest = await prisma.computerMetric.findFirst({ where: { computerId: id }, orderBy: { observedAt: "desc" } });
      const agentSession = await controllerSnapshot(id, control);
      return {
        id: computer.id, name: computer.name, hostname: computer.hostname, status: computer.status, provider: computer.provider, region: computer.region,
        vcpu: computer.vcpu, ramMb: computer.ramMb, storageGb: computer.storageGb, ipv4: instance?.ipv4 ?? computer.ipv4 ?? null,
        image: { name: computer.image.name, version: computer.image.version }, host: computer.host ? { id: computer.host.id, name: computer.host.name, provider: computer.host.provider } : null,
        uptimeSeconds: instance?.uptimeSeconds ?? Number(computer.uptimeSeconds), allowedActions: allowedActions(computer.status),
        controller: state, instance, desktop,
        agent: agentSession,
        metrics: latest ? { observedAt: latest.observedAt, cpuPercent: latest.cpuPercent, memoryUsedBytes: latest.memoryUsedBytes?.toString() ?? null, memoryTotalBytes: latest.memoryTotalBytes?.toString() ?? null, diskUsedBytes: latest.diskUsedBytes?.toString() ?? null, diskTotalBytes: latest.diskTotalBytes?.toString() ?? null, networkRxBytes: latest.networkRxBytes?.toString() ?? null, networkTxBytes: latest.networkTxBytes?.toString() ?? null, uptimeSeconds: latest.uptimeSeconds?.toString() ?? null } : null
      };
    });

    // Authenticated WebSocket bridge to the computer's noVNC/websockify port. The container
    // publishes no ports: the API authenticates the caller, checks ownership, then relays frames
    // to the container address on the managed Docker network.
    app.get("/:id/desktop", { websocket: true, preValidation: scope.console }, async (socket: SocketLike & { on(event: string, listener: (...args: never[]) => void): void }, req: FastifyRequest) => {
      const { id } = computerId.parse(req.params);
      const computer = await prisma.computer.findFirst({ where: { id, organizationId: req.auth!.organizationId, deletedAt: null }, include: { host: { include: { credential: true } } } });
      if (!computer || !computer.host || !computer.providerInstanceId) return socket.close(4404, "AI Computer is not available");
      if (computer.status !== "RUNNING") return socket.close(4409, `AI Computer is ${computer.status}`);
      const endpoint = await desktopEndpointOf(providerFor(computer.host, config), computer.providerInstanceId);
      if (!endpoint) return socket.close(4503, "Desktop stream endpoint is unavailable");

      let upstream: SocketLike;
      try { upstream = openWebSocket(endpoint.websockifyUrl, ["binary"]); }
      catch { return socket.close(4503, "Desktop stream could not be opened"); }
      upstream.binaryType = "arraybuffer";
      const pending: unknown[] = [];
      let ready = false;
      const shutdown = (code: number, reason: string) => {
        try { socket.close(code, reason); } catch { /* already closing */ }
        try { upstream.close(); } catch { /* already closing */ }
      };
      upstream.addEventListener("open", () => { ready = true; for (const frame of pending) upstream.send(frame); pending.length = 0; });
      upstream.addEventListener("message", event => { if (socket.readyState === 1 && event.data) socket.send(Buffer.from(event.data as ArrayBuffer)); });
      upstream.addEventListener("close", () => shutdown(1011, "Desktop stream closed"));
      upstream.addEventListener("error", () => shutdown(1011, "Desktop stream error"));
      socket.on("message", (data: unknown, isBinary: unknown) => {
        const frame = isBinary === false && typeof data === "string" ? data : data;
        if (ready) upstream.send(frame); else pending.push(frame);
      });
      socket.on("close", () => { try { upstream.close(); } catch { /* already closed */ } });
      socket.on("error", () => { try { upstream.close(); } catch { /* already closed */ } });
      // Hold the operator's control lock open while their desktop stream stays connected.
      const keepAlive = setInterval(() => { void control.get(id).then(current => { if (current.controller === "human" && current.holderId === req.auth!.userId) return control.refresh(id); }).catch(() => undefined); }, 60000);
      keepAlive.unref?.();
      socket.on("close", () => clearInterval(keepAlive));
    });
  };
}
