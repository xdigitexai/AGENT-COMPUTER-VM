import type { PrismaClient } from "@prisma/client";

export interface PlacementRequest { provider: string; region?: string; vcpu: number; ramMb: number; storageGb: number; }
export async function scheduleHost(db: PrismaClient, request: PlacementRequest) {
  const hosts = await db.computeHost.findMany({ where:{ enabled:true, maintenanceMode:false, provider:request.provider, ...(request.region?{region:request.region}:{}) }, include:{credential:true} });
  const eligible = hosts.filter(h => h.enabled && !h.maintenanceMode && h.credential && h.health !== "UNREACHABLE" && h.cpuCapacity-h.allocatedCpu>=request.vcpu && h.ramCapacityMb-h.allocatedRamMb>=request.ramMb && h.storageCapacityGb-h.allocatedStorageGb>=request.storageGb);
  const selected = eligible.sort((a,b) => ((a.allocatedRamMb/a.ramCapacityMb)+(a.allocatedCpu/a.cpuCapacity))-((b.allocatedRamMb/b.ramCapacityMb)+(b.allocatedCpu/b.cpuCapacity)))[0];
  if (!selected) throw Object.assign(new Error("No eligible compute host has sufficient capacity"),{code:"INSUFFICIENT_CAPACITY",statusCode:409});
  return selected;
}
