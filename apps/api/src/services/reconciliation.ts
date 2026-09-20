import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import { providerFor } from "../providers/factory.js";
export async function reconcile(db:PrismaClient,config:Config){
  const computers=await db.computer.findMany({where:{deletedAt:null,providerInstanceId:{not:null},hostId:{not:null}},include:{host:{include:{credential:true}}}});
  for(const computer of computers){if(!computer.host||!computer.providerInstanceId)continue;try{const actual=await providerFor(computer.host,config).getComputerStatus(computer.providerInstanceId);if(actual!==computer.status&&["RUNNING","STOPPED","SUSPENDED"].includes(actual))await db.computer.update({where:{id:computer.id},data:{status:actual,version:{increment:1}}});}catch{await db.computer.update({where:{id:computer.id},data:{status:"PROVIDER_UNAVAILABLE",version:{increment:1}}});}}
}
