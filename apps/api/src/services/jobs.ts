import type { JobType, PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import type { InfrastructureJobData } from "../queue.js";

const destructive = new Set<JobType>(["DELETE","SNAPSHOT_DELETE"]);
export async function enqueueInfrastructureJob(db:PrismaClient,queue:Queue<InfrastructureJobData>,input:{computerId?:string;type:JobType;idempotencyKey?:string;payload?:Record<string,unknown>}) {
  if(input.idempotencyKey){const prior=await db.provisioningJob.findUnique({where:{idempotencyKey:input.idempotencyKey}});if(prior)return prior;}
  const job=await db.provisioningJob.create({data:{computerId:input.computerId,type:input.type,idempotencyKey:input.idempotencyKey,payload:input.payload as object|undefined,maxAttempts:destructive.has(input.type)?1:3}});
  try { await queue.add(input.type,{provisioningJobId:job.id},{jobId:job.id,attempts:job.maxAttempts,backoff:{type:"exponential",delay:2000}}); }
  catch(error){await db.provisioningJob.update({where:{id:job.id},data:{status:"FAILED",errorCode:"QUEUE_UNAVAILABLE",errorMessage:"Infrastructure queue unavailable"}});throw error;}
  return job;
}
