import { Redis } from "ioredis";
import type { Config } from "../config.js";
import { redisConnection } from "../queue.js";

// Shared-control lock between the AI agent and a human operator.
//
// The lock lives in Redis so that it is enforced by the server for every caller instead of
// being a UI convention, and so it survives API process restarts. A human operator holds the
// lock for at most CONTROL_TTL_SECONDS and the live desktop stream refreshes it while the
// operator stays connected, which means an abandoned browser tab releases the agent on its own.
export type Controller = "agent" | "human";
export const CONTROL_TTL_SECONDS = 900;

export interface ControlState { controller: Controller; holderId: string | null; holderEmail: string | null; since: string | null; expiresInSeconds: number | null; }

export class ControlLock {
  private readonly redis: Redis;
  constructor(config: Config) {
    this.redis = new Redis({ ...redisConnection(config), connectionName: "xdigitex-control" });
    this.redis.on("error", error => console.error(JSON.stringify({ event: "control.redis_error", message: error.message })));
  }
  private key(computerId: string) { return `xdigitex:control:${computerId}`; }
  async get(computerId: string): Promise<ControlState> {
    const key = this.key(computerId);
    const [values, ttl] = await Promise.all([this.redis.hgetall(key), this.redis.ttl(key)]);
    if (!values || values.controller !== "human") return { controller: "agent", holderId: null, holderEmail: null, since: null, expiresInSeconds: null };
    return { controller: "human", holderId: values.holderId ?? null, holderEmail: values.holderEmail ?? null, since: values.since ?? null, expiresInSeconds: ttl > 0 ? ttl : null };
  }
  async take(computerId: string, holder: { userId: string; email?: string | null }): Promise<ControlState> {
    const key = this.key(computerId);
    await this.redis.hset(key, { controller: "human", holderId: holder.userId, holderEmail: holder.email ?? "", since: new Date().toISOString() });
    await this.redis.expire(key, CONTROL_TTL_SECONDS);
    return this.get(computerId);
  }
  async release(computerId: string): Promise<ControlState> {
    await this.redis.del(this.key(computerId));
    return this.get(computerId);
  }
  async refresh(computerId: string): Promise<void> { await this.redis.expire(this.key(computerId), CONTROL_TTL_SECONDS); }
  async close(): Promise<void> { await this.redis.quit().catch(() => undefined); }
}
