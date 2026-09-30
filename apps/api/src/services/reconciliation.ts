import type { ComputerStatus, PrismaClient } from "@prisma/client";
import type { Config } from "../config.js";
import { providerFor } from "../providers/factory.js";

const computeReservedStatuses = new Set<ComputerStatus>([
  "CREATING",
  "PROVISIONING",
  "STARTING",
  "RUNNING",
  "STOPPING",
  "REBOOTING",
  "SUSPENDING",
  "PROVIDER_UNAVAILABLE",
]);

async function reconcileHostAllocations(db: PrismaClient) {
  const hosts = await db.computeHost.findMany({ where: { enabled: true } });
  for (const host of hosts) {
    const computers = await db.computer.findMany({
      where: { hostId: host.id, deletedAt: null, status: { not: "DELETED" } },
      select: { status: true, vcpu: true, ramMb: true, storageGb: true },
    });
    let allocatedCpu = 0;
    let allocatedRamMb = 0;
    let allocatedStorageGb = 0;
    for (const computer of computers) {
      // CPU/RAM capacity is reserved only while the workload is active or transitioning.
      // STOPPED/SUSPENDED workloads retain storage but no longer make the host look compute-full.
      if (computeReservedStatuses.has(computer.status)) {
        allocatedCpu += computer.vcpu;
        allocatedRamMb += computer.ramMb;
      }
      allocatedStorageGb += computer.storageGb;
    }
    if (host.allocatedCpu !== allocatedCpu || host.allocatedRamMb !== allocatedRamMb || host.allocatedStorageGb !== allocatedStorageGb) {
      await db.computeHost.update({
        where: { id: host.id },
        data: { allocatedCpu, allocatedRamMb, allocatedStorageGb },
      });
    }
  }
}

export async function reconcile(db:PrismaClient,config:Config){
  const computers=await db.computer.findMany({where:{deletedAt:null,providerInstanceId:{not:null},hostId:{not:null}},include:{host:{include:{credential:true}}}});
  for(const computer of computers){if(!computer.host||!computer.providerInstanceId)continue;try{const actual=await providerFor(computer.host,config).getComputer(computer.providerInstanceId);if(!actual)continue;const data:{status?:typeof computer.status;ipv4?:string|null}={};if(actual.status!==computer.status&&["RUNNING","STOPPED","SUSPENDED","ERROR"].includes(actual.status))data.status=actual.status;if(actual.ipv4&&actual.ipv4!==computer.ipv4)data.ipv4=actual.ipv4;if(Object.keys(data).length)await db.computer.update({where:{id:computer.id},data:{...data,version:{increment:1}}});}catch{await db.computer.update({where:{id:computer.id},data:{status:"PROVIDER_UNAVAILABLE",version:{increment:1}}});}}
  const hosts=await db.computeHost.findMany({where:{enabled:true},include:{credential:true}});
  for(const host of hosts){try{const provider=providerFor(host,config);const health=await provider.healthCheck();await db.computeHost.update({where:{id:host.id},data:{health:health.ok?"HEALTHY":"UNREACHABLE",lastHeartbeatAt:new Date()}});if(!health.ok||!provider.listManagedComputers)continue;const managed=await provider.listManagedComputers();const known=new Set(computers.filter(c=>c.hostId===host.id).map(c=>c.id));for(const resource of managed)if(!known.has(resource.computerId))console.warn(JSON.stringify({event:"provider.orphan_detected",hostId:host.id,provider:host.provider,computerId:resource.computerId,providerInstanceId:resource.providerInstanceId}));}catch{await db.computeHost.update({where:{id:host.id},data:{health:"UNREACHABLE",lastHeartbeatAt:new Date()}});}}
  await reconcileHostAllocations(db);
}
