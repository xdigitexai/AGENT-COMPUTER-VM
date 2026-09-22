import type { Role } from "@prisma/client";
declare module "fastify" { interface FastifyRequest { auth?: { userId:string; organizationId:string; role:Role; scopes:string[]; agent:boolean }; } }
