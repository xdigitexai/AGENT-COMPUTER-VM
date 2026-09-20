import type { ComputerStatus, JobType, PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import type { InfrastructureJobData } from "../queue.js";
import { transition, type LifecycleAction } from "../domain/state-machine.js";
import { enqueueInfrastructureJob } from "./jobs.js";

const jobType:Record<LifecycleAction,JobType>={provision:"PROVISION",start:"START",stop:"STOP",restart:"RESTART",suspend:"SUSPEND",resume:"RESUME",delete:"DELETE"};
const desired:Partial<Record<LifecycleAction,ComputerStatus>>={provision:"RUNNING",start:"RUNNING",stop:"STOPPED",restart:"RUNNING",suspend:"SUSPENDED",resume:"RUNNING",delete:"DELETED"};
export async function requestLifecycle(db:PrismaClient,queue:Queue<InfrastructureJobData>,input:{computerId:string;organizationId:string;action:LifecycleAction;idempotencyKey?:string}){
  return db.$transaction(async tx=>{
    const computer=await tx.computer.findFirst({where:{id:input.computerId,organizationId:input.organizationId,deletedAt:null}});
    if(!computer) throw Object.assign(new Error("Computer not found"),{statusCode:404,code:"NOT_FOUND"});
    const next=transition(computer.status,input.action);
    const changed=await tx.computer.updateMany({where:{id:computer.id,status:computer.status,version:computer.version},data:{status:next,desiredStatus:desired[input.action],version:{increment:1}}});
    if(changed.count!==1) throw Object.assign(new Error("Computer state changed concurrently"),{statusCode:409,code:"CONCURRENT_OPERATION"});
    return enqueueInfrastructureJob(tx as PrismaClient,queue,{computerId:computer.id,type:jobType[input.action],idempotencyKey:input.idempotencyKey});
  });
}
