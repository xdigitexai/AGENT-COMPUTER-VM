import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { InfrastructureJobData } from "../queue.js";
import { prisma } from "../db.js";
import type { Config } from "../config.js";
import { providerFor } from "../providers/factory.js";
export function healthRoutes(queue:Queue<InfrastructureJobData>,config:Config){return async(app:FastifyInstance)=>{
  app.get("/health",async()=>({status:"ok",application:"ok",time:new Date().toISOString()}));
  app.get("/ready",async(_req,reply)=>{const checks:{database:string;redis:string;worker:string}={database:"unavailable",redis:"unavailable",worker:"unavailable"};try{await prisma.$queryRaw`SELECT 1`;checks.database="ok";}catch{}try{await queue.getJobCounts();checks.redis="ok";}catch{}try{const workers=await queue.getWorkers();checks.worker=workers.length?"ok":"unavailable";}catch{}const providers:{hostId:string;provider:string;status:string;message?:string}[]=[];try{const hosts=await prisma.computeHost.findMany({where:{enabled:true},include:{credential:true}});for(const host of hosts){try{const health=await providerFor(host,config).healthCheck();providers.push({hostId:host.id,provider:host.provider,status:health.ok?"ok":"unavailable",message:health.message});}catch(error){providers.push({hostId:host.id,provider:host.provider,status:"unavailable",message:error instanceof Error?error.message:"Provider unavailable"});}}}catch{}const ready=Object.values(checks).every(v=>v==="ok");return reply.code(ready?200:503).send({status:ready?"ready":"not_ready",checks,providers,computeAvailable:providers.some(p=>p.status==="ok")});});
};}
