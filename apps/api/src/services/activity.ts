import { Redis } from "ioredis";
import type { ActivityEvent, PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import { redisConnection } from "../queue.js";

// Live activity stream for an AI Computer.
//
// Every meaningful thing an agent or an operator does is appended to `ActivityEvent` (durable,
// owner-scoped, queryable) and published on a per-computer Redis channel. The authenticated
// events WebSocket fans that channel out to the viewer, so the panel beside the desktop shows
// the same story the desktop itself is telling.
export interface ActivityInput {
  computerId: string;
  organizationId: string;
  agentRunId?: string | null;
  kind: string;
  message: string;
  severity?: "info" | "success" | "warn" | "error";
  metadata?: Record<string, unknown>;
}

export interface ActivityView {
  id: string;
  computerId: string;
  agentRunId: string | null;
  kind: string;
  message: string;
  severity: string;
  metadata: unknown;
  createdAt: string;
}

export const activityChannel = (computerId: string) => `xdigitex:activity:${computerId}`;
export const ACTIVITY_REPLAY_LIMIT = 60;

export function toActivityView(row: ActivityEvent): ActivityView {
  return {
    id: row.id.toString(),
    computerId: row.computerId,
    agentRunId: row.agentRunId ?? null,
    kind: row.kind,
    message: row.message,
    severity: row.severity,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt.toISOString()
  };
}

export class ActivityHub {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

  constructor(private readonly config: Config) {
    const options = { ...redisConnection(config) };
    this.publisher = new Redis({ ...options, connectionName: "xdigitex-activity-pub" });
    this.subscriber = new Redis({ ...options, connectionName: "xdigitex-activity-sub" });
    const onError = (tag: string) => (error: Error) => console.error(JSON.stringify({ event: `activity.${tag}_error`, message: error.message }));
    this.publisher.on("error", onError("redis"));
    this.subscriber.on("error", onError("subscriber"));
  }

  /** Persists the event and pushes it to every live viewer. */
  async record(prisma: PrismaClient, input: ActivityInput): Promise<ActivityView> {
    const row = await prisma.activityEvent.create({
      data: {
        computerId: input.computerId,
        organizationId: input.organizationId,
        agentRunId: input.agentRunId ?? null,
        kind: input.kind,
        message: input.message.slice(0, 500),
        severity: input.severity ?? "info",
        metadata: (input.metadata ?? undefined) as object | undefined
      }
    });
    const view = toActivityView(row);
    await this.publish(view);
    return view;
  }

  /** Records an activity event without letting a failure break the action that produced it. */
  async tryRecord(prisma: PrismaClient, input: ActivityInput): Promise<void> {
    try { await this.record(prisma, input); }
    catch (error) { console.error(JSON.stringify({ event: "activity.record_failed", kind: input.kind, message: error instanceof Error ? error.message : "unknown" })); }
  }

  async recent(prisma: PrismaClient, computerId: string, limit = ACTIVITY_REPLAY_LIMIT): Promise<ActivityView[]> {
    const rows = await prisma.activityEvent.findMany({ where: { computerId }, orderBy: { id: "desc" }, take: Math.min(Math.max(limit, 1), 200) });
    return rows.reverse().map(toActivityView);
  }

  private async publish(view: ActivityView): Promise<void> {
    try { await this.publisher.publish(activityChannel(view.computerId), JSON.stringify(view)); }
    catch (error) { console.error(JSON.stringify({ event: "activity.publish_failed", message: error instanceof Error ? error.message : "unknown" })); }
  }

  /** Tails one computer's channel. Returns a disposer that removes the listener. */
  async subscribe(computerId: string, handler: (view: ActivityView) => void): Promise<() => Promise<void>> {
    const channel = activityChannel(computerId);
    const listener = (incoming: string, payload: string) => {
      if (incoming !== channel) return;
      try { handler(JSON.parse(payload) as ActivityView); } catch { /* malformed frame */ }
    };
    this.subscriber.on("message", listener);
    await this.subscriber.subscribe(channel);
    return async () => {
      try {
        this.subscriber.off("message", listener);
        await this.subscriber.unsubscribe(channel);
      } catch { /* shutting down */ }
    };
  }

  async close(): Promise<void> {
    await Promise.all([
      this.publisher.quit().catch(() => undefined),
      this.subscriber.quit().catch(() => undefined)
    ]);
  }
}
