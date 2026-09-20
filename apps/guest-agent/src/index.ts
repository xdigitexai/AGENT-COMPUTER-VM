import Fastify from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";

const tokenHash=process.env.GUEST_AGENT_TOKEN_HASH;if(!tokenHash)throw new Error("GUEST_AGENT_TOKEN_HASH is required");
const allowed=new Set((process.env.GUEST_AGENT_ALLOWED_COMMANDS??"").split(",").map(x=>x.trim()).filter(Boolean));
const maxOutput=Number(process.env.GUEST_AGENT_MAX_OUTPUT_BYTES??1048576);const defaultTimeout=Number(process.env.GUEST_AGENT_COMMAND_TIMEOUT_MS??30000);
const app=Fastify({logger:{redact:["req.headers.authorization"]},bodyLimit:2*1024*1024});
app.addHook("preHandler",async(req,reply)=>{if(req.url==="/health")return;const token=req.headers.authorization?.replace(/^Bearer /i,"")??"";const actual=Buffer.from(createHash("sha256").update(token).digest("hex"));const expected=Buffer.from(tokenHash);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply.code(401).send({error:"unauthorized"});});
app.get("/health",async()=>({status:"ok"}));
app.get("/v1/system",async()=>({platform:process.platform,architecture:process.arch,nodeVersion:process.version,uptimeSeconds:process.uptime()}));
app.post("/v1/commands",async(req,reply)=>{const input=z.object({executable:z.string().min(1).max(512),arguments:z.array(z.string().max(4096)).max(128).default([]),cwd:z.string().max(4096).optional(),timeoutMs:z.number().int().positive().max(300000).default(defaultTimeout)}).parse(req.body);if(!allowed.has(input.executable))return reply.code(403).send({error:"command_not_allowed"});const startedAt=new Date();const result=await new Promise<{exitCode:number|null;stdout:string;stderr:string;truncated:boolean}>((resolve,reject)=>{const child=spawn(input.executable,input.arguments,{cwd:input.cwd,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),truncated=false;const collect=(current:Buffer,chunk:Buffer)=>{const remaining=maxOutput-current.length;if(chunk.length>remaining)truncated=true;return Buffer.concat([current,chunk.subarray(0,Math.max(0,remaining))]);};child.stdout.on("data",c=>stdout=collect(stdout,c));child.stderr.on("data",c=>stderr=collect(stderr,c));const timer=setTimeout(()=>child.kill("SIGKILL"),input.timeoutMs);child.on("error",reject);child.on("close",code=>{clearTimeout(timer);resolve({exitCode:code,stdout:stdout.toString("utf8"),stderr:stderr.toString("utf8"),truncated});});});app.log.info({event:"command.completed",executable:input.executable,exitCode:result.exitCode,durationMs:Date.now()-startedAt.getTime()});return {...result,startedAt,completedAt:new Date()};});
await app.listen({host:"127.0.0.1",port:Number(process.env.GUEST_AGENT_PORT??4317)});
