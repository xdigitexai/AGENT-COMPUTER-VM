import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { InfrastructureJobData } from "../queue.js";
import { prisma } from "../db.js";
export function healthRoutes(queue:Queue<InfrastructureJobData>){return async(app:FastifyInstance)=>{
  app.get("/health",async()=>({status:"ok",application:"ok",time:new Date().toISOString()}));
  app.get("/ready",async(_req,reply)=>{const checks:{database:string;redis:string;worker:string}={database:"unavailable",redis:"unavailable",worker:"unavailable"};try{await prisma.$queryRaw`SELECT 1`;checks.database="ok";}catch{}try{await queue.getJobCounts();checks.redis="ok";}catch{}try{const workers=await queue.getWorkers();checks.worker=workers.length?"ok":"unavailable";}catch{}const ready=Object.values(checks).every(v=>v==="ok");return reply.code(ready?200:503).send({status:ready?"ready":"not_ready",checks});});
};}
