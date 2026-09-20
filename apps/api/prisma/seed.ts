import {PrismaClient} from "@prisma/client";
const db=new PrismaClient();
await db.computePlan.upsert({where:{name:"Development"},update:{},create:{name:"Development",computerLimit:5,runningComputerLimit:2,cpuAllowance:16,ramAllowanceMb:32768,storageAllowanceGb:500}});
await db.computerImage.upsert({where:{provider_providerImageId:{provider:"proxmox",providerImageId:"9000"}},update:{},create:{name:"Ubuntu",version:"24.04 LTS",provider:"proxmox",providerImageId:"9000"}});
await db.computerImage.upsert({where:{provider_providerImageId:{provider:"docker",providerImageId:"xdigitex/agent-computer:2026.09"}},update:{},create:{name:"XDIGITEX Ubuntu Agent",version:"2026.09",provider:"docker",providerImageId:"xdigitex/agent-computer:2026.09"}});
await db.$disconnect();
