import type { PrismaClient } from "@prisma/client";
export async function enforceCreateQuota(db:PrismaClient,organizationId:string,planId:string,resources:{vcpu:number;ramMb:number;storageGb:number}) {
  const [plan,computers,running]=await Promise.all([db.computePlan.findUnique({where:{id:planId}}),db.computer.aggregate({where:{organizationId,deletedAt:null},_count:true,_sum:{vcpu:true,ramMb:true,storageGb:true}}),db.computer.count({where:{organizationId,deletedAt:null,status:{in:["RUNNING","STARTING","REBOOTING","PROVISIONING","CREATING"]}}})]);
  if(!plan||!plan.enabled) throw Object.assign(new Error("Plan unavailable"),{statusCode:409,code:"PLAN_UNAVAILABLE"});
  if(running>=plan.runningComputerLimit||computers._count>=plan.computerLimit||resources.vcpu+(computers._sum.vcpu??0)>plan.cpuAllowance||resources.ramMb+(computers._sum.ramMb??0)>plan.ramAllowanceMb||resources.storageGb+(computers._sum.storageGb??0)>plan.storageAllowanceGb) throw Object.assign(new Error("Plan quota exceeded"),{statusCode:409,code:"QUOTA_EXCEEDED"});
}
