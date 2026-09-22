import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Queue } from "bullmq";
import { prisma } from "../db.js";
import { requireAnyScope, requireScope } from "../auth.js";
import { ProviderError } from "../providers/types.js";
import type { Config } from "../config.js";
import type { ActivityHub } from "../services/activity.js";
import type { ControlLock } from "../services/control.js";
import type { AgentJobData } from "../queue.js";
import {
  ACTIVE_RUN_STATUSES, activeRunFor, chooseRecipe, computerContext, controllerSnapshot, createRun,
  executeRun, finishRun, latestRunFor, observeComputer, recipes, toRunView
} from "../services/agent.js";
import { agentActionTypes, performAction, safeActivityMetadata, type AgentAction } from "../services/agent-actions.js";

// The XDIGITEX Agent API: an agent attaches to an AI Computer that is already running, observes
// it, acts on it, and detaches. Nothing here creates or deletes a computer, and every action is
// scoped to the caller's organization by the shared resolver below.
const computerId = z.object({ id: z.string().uuid() });
const coordinate = z.number().int().min(0).max(16384);
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), x: coordinate, y: coordinate }),
  z.object({ type: z.literal("click"), x: coordinate, y: coordinate, button: z.number().int().min(1).max(5).default(1), clicks: z.number().int().min(1).max(5).default(1) }),
  z.object({ type: z.literal("double_click"), x: coordinate, y: coordinate }),
  z.object({ type: z.literal("right_click"), x: coordinate, y: coordinate }),
  z.object({ type: z.literal("type"), text: z.string().min(1).max(4000), delayMs: z.number().int().min(0).max(500).default(25) }),
  z.object({ type: z.literal("key"), keys: z.string().min(1).max(120).regex(/^[A-Za-z0-9+_\-.]+( [A-Za-z0-9+_\-.]+)*$/, "Use xdotool key syntax such as ctrl+alt+t or Return") }),
  z.object({ type: z.literal("scroll"), x: coordinate.optional(), y: coordinate.optional(), direction: z.enum(["up", "down"]), amount: z.number().int().min(1).max(50).default(3) }),
  z.object({ type: z.literal("drag"), fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate, button: z.number().int().min(1).max(5).default(1) }),
  z.object({ type: z.literal("browser_navigate"), url: z.string().url().max(2048) }),
  z.object({ type: z.literal("browser_open_tab"), url: z.string().url().max(2048).optional() }),
  z.object({ type: z.literal("browser_click"), selector: z.string().min(1).max(400) }),
  z.object({ type: z.literal("browser_type"), selector: z.string().min(1).max(400), text: z.string().max(4000) }),
  z.object({ type: z.literal("browser_press"), key: z.string().min(1).max(40) }),
  z.object({ type: z.literal("browser_evaluate"), expression: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("focus_browser") }),
  z.object({ type: z.literal("open_terminal") }),
  z.object({ type: z.literal("visible_command"), command: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("terminal_command"), command: z.string().min(1).max(4000), timeoutMs: z.number().int().min(1000).max(300000).default(60000) }),
  z.object({ type: z.literal("screenshot") }),
  z.object({ type: z.literal("wait"), ms: z.number().int().min(100).max(120000) })
]);

export function agentRoutes(queue: Queue<AgentJobData>, config: Config, control: ControlLock, activity: ActivityHub) {
  return async (app: FastifyInstance) => {
    const agentScope = requireScope("computer:agent");
    const readScope = requireScope("computer:read");
    const consoleScope = requireScope("computer:console");
    const eitherScope = requireAnyScope(["computer:console", "computer:agent"]);

    async function owned(req: FastifyRequest, reply: FastifyReply, id: string) {
      const computer = await prisma.computer.findFirst({ where: { id, organizationId: req.auth!.organizationId, deletedAt: null } });
      if (!computer) { await reply.code(404).send({ error: { code: "NOT_FOUND", message: "AI Computer is not available" } }); return null; }
      return computer;
    }

    async function audit(req: FastifyRequest, computerIdValue: string, action: string, metadata: Record<string, unknown> = {}) {
      await prisma.auditLog.create({ data: { actorId: req.auth!.userId, organizationId: req.auth!.organizationId, action, resourceType: "Computer", resourceId: computerIdValue, ipAddress: req.ip, metadata: metadata as object } });
    }

    // A run id supplied by a caller must belong to this computer; otherwise the agent could
    // attribute work to somebody else's run.
    async function runFor(req: FastifyRequest, reply: FastifyReply, id: string, agentRunId?: string) {
      if (agentRunId) {
        const run = await prisma.agentRun.findFirst({ where: { id: agentRunId, computerId: id, organizationId: req.auth!.organizationId } });
        if (!run) { await reply.code(404).send({ error: { code: "RUN_NOT_FOUND", message: "Agent run does not belong to this AI Computer" } }); return null; }
        return run;
      }
      return activeRunFor(id);
    }

    // While a human operator holds control, agent input is refused by the server.
    async function gate(req: FastifyRequest, reply: FastifyReply, id: string) {
      const state = await control.get(id);
      if (state.controller !== "human") return state;
      const isHolder = !req.auth!.agent && state.holderId === req.auth!.userId;
      if (isHolder) return state;
      await reply.code(409).send({ error: { code: "CONTROLLER_BUSY", message: "A human operator holds control of this AI Computer, so agent input is paused. Release control to let the agent resume.", controller: state.controller, holderId: state.holderId } });
      return null;
    }

    // Attach to an existing computer: creates (or reuses) an agent run bound to this computer.
    app.post("/:id/attach", { preHandler: eitherScope }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      const input = z.object({
        agentRunId: z.string().uuid().optional(),
        agentName: z.string().min(1).max(80).optional(),
        title: z.string().min(1).max(160).optional(),
        instruction: z.string().max(2000).optional(),
        recipe: z.string().max(80).optional(),
        start: z.boolean().default(true)
      }).parse(req.body ?? {});
      const computer = await owned(req, reply, id);
      if (!computer) return;

      const isAgent = Boolean(req.auth!.agent);
      let run = input.agentRunId
        ? await prisma.agentRun.findFirst({ where: { id: input.agentRunId, computerId: id, organizationId: req.auth!.organizationId } })
        : null;
      if (input.agentRunId && !run) return reply.code(404).send({ error: { code: "RUN_NOT_FOUND", message: "Agent run does not belong to this AI Computer" } });

      if (run && ["COMPLETED", "FAILED", "DETACHED"].includes(run.status)) {
        return reply.code(409).send({ error: { code: "RUN_FINISHED", message: `Agent run is ${run.status} and cannot be reattached; attach without an agentRunId to start a new run` } });
      }
      if (!run) {
        const existing = await activeRunFor(id);
        if (existing && isAgent) {
          return reply.code(409).send({ error: { code: "SESSION_BUSY", message: "Another agent run is already attached to this AI Computer", agentRunId: existing.id, status: existing.status } });
        }
        run = await createRun({
          computerId: id, organizationId: req.auth!.organizationId, ownerId: computer.ownerId,
          actorId: req.auth!.userId, actorKind: isAgent ? "agent" : "human",
          agentName: input.agentName ?? (isAgent ? "XDIGITEX Agent" : "Console operator"),
          title: input.title, instruction: input.instruction ?? null, recipe: input.recipe ?? null,
          source: isAgent ? "agent-api" : "console"
        });
        await activity.tryRecord(prisma, { computerId: id, organizationId: req.auth!.organizationId, agentRunId: run.id, kind: "agent.connected", message: `${run.agentName} connected to ${computer.name}` });
      }

      // A queued task runs on the worker; an agent that drives the desktop itself just attaches.
      const wantsTask = input.start && Boolean(input.instruction || input.recipe) && run.status === "ATTACHED";
      if (wantsTask) await queue.add("run", { agentRunId: run.id }, { jobId: `${run.id}` });

      await audit(req, id, "computer.agent.attach", { agentRunId: run.id, recipe: run.recipe ?? null, queued: wantsTask });
      const snapshot = await controllerSnapshot(id, control);
      return reply.code(wantsTask ? 202 : 200).send({
        computerId: id, agentRun: toRunView(run), queued: wantsTask,
        controller: snapshot.controller, session: snapshot.session,
        recipe: (run.recipe ? recipes.find(recipe => recipe.id === run.recipe) : chooseRecipe(run.instruction, run.recipe)) ?? null
      });
    });

    app.post("/:id/detach", { preHandler: agentScope }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      const input = z.object({ agentRunId: z.string().uuid().optional(), reason: z.string().max(300).optional() }).parse(req.body ?? {});
      const computer = await owned(req, reply, id);
      if (!computer) return;
      const run = await runFor(req, reply, id, input.agentRunId);
      if (!run) return reply.code(404).send({ error: { code: "NO_ACTIVE_RUN", message: "No agent run is attached to this AI Computer" } });
      if (!["COMPLETED", "FAILED", "DETACHED"].includes(run.status)) {
        await finishRun(run.id, "DETACHED");
        await activity.tryRecord(prisma, { computerId: id, organizationId: req.auth!.organizationId, agentRunId: run.id, kind: "agent.detached", message: `${run.agentName} detached${input.reason ? `: ${input.reason}` : ""} — the desktop and the computer stay running`, severity: "info" });
      }
      await audit(req, id, "computer.agent.detach", { agentRunId: run.id });
      const snapshot = await controllerSnapshot(id, control);
      return { computerId: id, agentRunId: run.id, detached: true, computerStatus: computer.status, controller: snapshot.controller, session: snapshot.session };
    });

    // The observe half of the loop: screenshot + geometry + the visible browser's tabs.
    app.post("/:id/observe", { preHandler: agentScope }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      const input = z.object({ agentRunId: z.string().uuid().optional(), includeImage: z.boolean().default(true) }).parse(req.body ?? {});
      const computer = await owned(req, reply, id);
      if (!computer) return;
      if (computer.status !== "RUNNING") return reply.code(409).send({ error: { code: "NOT_RUNNING", message: `The AI Computer is ${computer.status}; start it before observing it` } });
      try {
        const observation = await observeComputer(id, config, { includeImage: input.includeImage, agentRunId: input.agentRunId ?? null });
        const snapshot = await controllerSnapshot(id, control);
        await audit(req, id, "computer.agent.observe", { agentRunId: input.agentRunId ?? null, includeImage: input.includeImage });
        return { ...observation, controller: snapshot.controller, liveController: snapshot };
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : "OPERATION_FAILED";
        return reply.code(code === "RESOURCE_NOT_FOUND" ? 404 : 409).send({ error: { code, message: error instanceof Error ? error.message : "Observation failed" } });
      }
    });

    // Every action returns an explicit success/failure, and each one drives the visible desktop.
    app.post("/:id/actions", { preHandler: agentScope }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      const input = z.object({
        agentRunId: z.string().uuid().optional(),
        label: z.string().max(200).optional(),
        action: actionSchema
      }).parse(req.body);
      const computer = await owned(req, reply, id);
      if (!computer) return;
      if (computer.status !== "RUNNING") return reply.code(409).send({ error: { code: "NOT_RUNNING", message: `The AI Computer is ${computer.status}; start it before sending agent actions` } });
      if (!(await gate(req, reply, id))) return;

      let context;
      try { context = await computerContext(id, config); }
      catch (error) {
        const code = error instanceof ProviderError ? error.code : "OPERATION_FAILED";
        return reply.code(409).send({ error: { code, message: error instanceof Error ? error.message : "The desktop is unavailable" } });
      }
      const action = input.action as AgentAction;
      const result = await performAction(context.action, action);
      await activity.tryRecord(prisma, {
        computerId: id, organizationId: req.auth!.organizationId, agentRunId: input.agentRunId ?? null,
        kind: `agent.action.${action.type}`, message: input.label ?? result.message,
        severity: result.ok ? "info" : "error", metadata: safeActivityMetadata(result.detail)
      });
      await audit(req, id, "computer.agent.action", { type: action.type, ok: result.ok, agentRunId: input.agentRunId ?? null });
      const payload = { computerId: id, action: action.type, ok: result.ok, message: result.message, detail: result.detail };
      return reply.code(result.ok ? 200 : 422).send(payload);
    });

    app.get("/:id/controller", { preHandler: readScope }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      if (!(await owned(req, reply, id))) return;
      const snapshot = await controllerSnapshot(id, control);
      const latest = await latestRunFor(id);
      return { ...snapshot, lastRun: latest ? toRunView(latest) : null };
    });

    // A human asks for control; an agent asks for a human. Both are recorded on the live stream.
    app.post("/:id/controller/request", { preHandler: eitherScope }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      const input = z.object({
        agentRunId: z.string().uuid().optional(),
        reason: z.string().max(300).optional()
      }).parse(req.body ?? {});
      const computer = await owned(req, reply, id);
      if (!computer) return;

      if (req.auth!.agent) {
        // The agent has hit something only a human can do: pause and wait on the live desktop.
        const run = await runFor(req, reply, id, input.agentRunId);
        if (!run) return reply.code(404).send({ error: { code: "NO_ACTIVE_RUN", message: "No agent run is attached to this AI Computer" } });
        await prisma.agentRun.update({ where: { id: run.id }, data: { status: "WAITING_FOR_HUMAN", phase: input.reason ?? "Waiting for a human" } });
        await activity.tryRecord(prisma, { computerId: id, organizationId: req.auth!.organizationId, agentRunId: run.id, kind: "agent.waiting_for_human", message: "Agent paused — login required", severity: "warn", metadata: { reason: input.reason ?? "login required" } });
        await audit(req, id, "computer.controller.request", { agentRunId: run.id, by: "agent" });
        return reply.code(202).send(await controllerSnapshot(id, control));
      }

      const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true } });
      const state = await control.take(id, { userId: req.auth!.userId, email: user?.email ?? null });
      await activity.tryRecord(prisma, { computerId: id, organizationId: req.auth!.organizationId, kind: "human.took_control", message: `Human took control${user?.email ? ` (${user.email})` : ""}${input.reason ? `: ${input.reason}` : ""}`, severity: "warn" });
      await audit(req, id, "computer.controller.request", { by: "human" });
      return { computerId: id, ...state, session: (await controllerSnapshot(id, control)).session };
    });

    // Only an interactive signed-in session can hand control back to the agent.
    app.post("/:id/controller/release", { preHandler: consoleScope }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      if (req.auth!.agent) return reply.code(403).send({ error: { code: "HUMAN_REQUIRED", message: "Control can only be released from an interactive signed-in session" } });
      if (!(await owned(req, reply, id))) return;
      const held = await control.get(id);
      const state = await control.release(id);
      const waiting = await activeRunFor(id);
      if (waiting?.status === "WAITING_FOR_HUMAN") {
        await prisma.agentRun.update({ where: { id: waiting.id }, data: { status: "ATTACHED", phase: "Human control released" } });
      }
      await activity.tryRecord(prisma, { computerId: id, organizationId: req.auth!.organizationId, agentRunId: waiting?.id ?? null, kind: "human.control_released", message: "Human released control", severity: "info", metadata: { heldFor: held.since } });
      await activity.tryRecord(prisma, { computerId: id, organizationId: req.auth!.organizationId, agentRunId: waiting?.id ?? null, kind: "HUMAN_CONTROL_RELEASED", message: "Agent resumed — HUMAN_CONTROL_RELEASED", severity: "success" });
      await audit(req, id, "computer.controller.release", { by: "human" });
      return { computerId: id, ...state, session: (await controllerSnapshot(id, control)).session };
    });

    app.get("/:id/agent-runs", { preHandler: readScope }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      if (!(await owned(req, reply, id))) return;
      const runs = await prisma.agentRun.findMany({ where: { computerId: id }, orderBy: { createdAt: "desc" }, take: 20 });
      return { data: runs.map(toRunView), active: ACTIVE_RUN_STATUSES };
    });

    app.get("/:id/activity", { preHandler: readScope }, async (req, reply) => {
      const { id } = computerId.parse(req.params);
      if (!(await owned(req, reply, id))) return;
      const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) }).parse(req.query ?? {});
      return { data: await activity.recent(prisma, id, query.limit) };
    });

    // Runs a recipe synchronously in this process. Used by the console's "Use with Agent" when the
    // worker is not consuming the agent queue, and by operational checks.
    app.post("/:id/agent-runs/:runId/execute", { preHandler: readScope }, async (req, reply) => {
      const params = z.object({ id: z.string().uuid(), runId: z.string().uuid() }).parse(req.params);
      if (!(await owned(req, reply, params.id))) return;
      const run = await prisma.agentRun.findFirst({ where: { id: params.runId, computerId: params.id, organizationId: req.auth!.organizationId } });
      if (!run) return reply.code(404).send({ error: { code: "RUN_NOT_FOUND", message: "Agent run does not belong to this AI Computer" } });
      const outcome = await executeRun(run.id, { config, control, activity });
      const latest = await prisma.agentRun.findUnique({ where: { id: run.id } });
      return { computerId: params.id, ...outcome, agentRun: latest ? toRunView(latest) : null };
    });
  };
}

// Catalog endpoints: what an agent can be asked to do, and what actions exist. Mounted at
// /api/v1/agent so they are not tied to a specific computer.
export function agentCatalogRoutes() {
  return async (app: FastifyInstance) => {
    const readScope = requireScope("computer:read");
    app.get("/recipes", { preHandler: readScope }, async () => ({
      data: recipes.map(recipe => ({ id: recipe.id, title: recipe.title, description: recipe.description }))
    }));
    app.get("/actions", { preHandler: readScope }, async () => ({ data: agentActionTypes }));
  };
}
