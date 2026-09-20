import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(32),
  LOG_LEVEL: z.string().default("info"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  WORKER_HEARTBEAT_TTL_SECONDS: z.coerce.number().positive().default(60),
  RECONCILIATION_INTERVAL_SECONDS: z.coerce.number().positive().default(60),
  METRICS_INTERVAL_SECONDS: z.coerce.number().positive().default(60)
});

export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid environment: ${result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ")}`);
  return result.data;
}
