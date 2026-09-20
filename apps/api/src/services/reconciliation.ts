import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import { providerFor } from "../providers/factory.js";
export async function reconcile(db:PrismaClient,config:Config){
  const computers=await db.computer.findMany({where:{deletedAt:null,providerInstanceId:{not:null},hostId:{not:null}},include:{host:{include:{credential:true}}}});
  for(const computer of computers){if(!computer.host||!computer.providerInstanceId)continue;try{const actual=await providerFor(computer.host,config).getComputerStatus(computer.providerInstanceId);if(actual!==computer.status&&["RUNNING","STOPPED","SUSPENDED","ERROR"].includes(actual))await db.computer.update({where:{id:computer.id},data:{status:actual,version:{increment:1}}});}catch{await db.computer.update({where:{id:computer.id},data:{status:"PROVIDER_UNAVAILABLE",version:{increment:1}}});}}
  const hosts=await db.computeHost.findMany({where:{enabled:true},include:{credential:true}});
  for(const host of hosts){try{const provider=providerFor(host,config);const health=await provider.healthCheck();await db.computeHost.update({where:{id:host.id},data:{health:health.ok?"HEALTHY":"UNREACHABLE",lastHeartbeatAt:new Date()}});if(!health.ok||!provider.listManagedComputers)continue;const managed=await provider.listManagedComputers();const known=new Set(computers.filter(c=>c.hostId===host.id).map(c=>c.id));for(const resource of managed)if(!known.has(resource.computerId))console.warn(JSON.stringify({event:"provider.orphan_detected",hostId:host.id,provider:host.provider,computerId:resource.computerId,providerInstanceId:resource.providerInstanceId}));}catch{await db.computeHost.update({where:{id:host.id},data:{health:"UNREACHABLE",lastHeartbeatAt:new Date()}});}}
}
