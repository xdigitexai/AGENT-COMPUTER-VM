import { Queue } from "bullmq";
import type { Config } from "./config.js";
export const QUEUE_NAME = "infrastructure";
export type InfrastructureJobData = { provisioningJobId: string };
export function redisConnection(config:Config) { const url=new URL(config.REDIS_URL); return {host:url.hostname,port:Number(url.port||6379),username:url.username||undefined,password:url.password||undefined,tls:url.protocol==="rediss:"?{}:undefined,maxRetriesPerRequest:null}; }
export function createInfrastructureQueue(config:Config) { return new Queue<InfrastructureJobData>(QUEUE_NAME,{connection:redisConnection(config),defaultJobOptions:{removeOnComplete:1000,removeOnFail:5000}}); }

// Agent tasks are long-running desktop work, so they run on the worker process rather than inside
// the request that attached them. One job = one AgentRun bound to one existing computer.
export const AGENT_QUEUE_NAME = "agent-runs";
export type AgentJobData = { agentRunId: string };
export function createAgentQueue(config:Config) { return new Queue<AgentJobData>(AGENT_QUEUE_NAME,{connection:redisConnection(config),defaultJobOptions:{removeOnComplete:500,removeOnFail:1000}}); }
