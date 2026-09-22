import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@prisma/client";
import { prisma } from "./db.js";
import { hashToken } from "./security/crypto.js";

const rank:Record<Role,number>={USER:0,ORG_ADMIN:1,ADMIN:2,SUPER_ADMIN:3};
export const roleAllows=(actual:Role,required:Role)=>rank[actual]>=rank[required];
export const tenantAllows=(requestedOrganizationId:string,memberships:{organizationId:string}[],globalRole:Role)=>memberships.some(m=>m.organizationId===requestedOrganizationId)||roleAllows(globalRole,"ADMIN");
export async function authenticate(request:FastifyRequest,reply:FastifyReply){
  const bearer=request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1]; const session=request.cookies.session;
  if(bearer){const key=await prisma.apiKey.findUnique({where:{tokenHash:hashToken(bearer)},include:{user:true}});if(!key||key.revokedAt||key.expiresAt&&key.expiresAt<new Date()||key.user.status!=="ACTIVE")return reply.code(401).send({error:{code:"UNAUTHENTICATED",message:"Invalid API key"}});request.auth={userId:key.userId,organizationId:key.organizationId,role:key.user.role,scopes:key.scopes,agent:true};void prisma.apiKey.update({where:{id:key.id},data:{lastUsedAt:new Date()}});return;}
  if(session){const record=await prisma.session.findUnique({where:{tokenHash:hashToken(session)},include:{user:{include:{memberships:true}}}});if(!record||record.expiresAt<new Date()||record.user.status!=="ACTIVE")return reply.code(401).send({error:{code:"UNAUTHENTICATED",message:"Session expired"}});const orgId=request.headers["x-organization-id"]?.toString()??record.user.memberships[0]?.organizationId;if(!orgId)return reply.code(403).send({error:{code:"NO_TENANT",message:"No organization selected"}});const member=record.user.memberships.find(m=>m.organizationId===orgId);if(!tenantAllows(orgId,record.user.memberships,record.user.role))return reply.code(403).send({error:{code:"FORBIDDEN",message:"Organization access denied"}});request.auth={userId:record.userId,organizationId:orgId,role:member?.role??record.user.role,scopes:["*"],agent:false};return;}
  return reply.code(401).send({error:{code:"UNAUTHENTICATED",message:"Authentication required"}});
}
export function requireScope(scope:string){return async(req:FastifyRequest,reply:FastifyReply)=>{await authenticate(req,reply);if(reply.sent)return;if(!req.auth?.scopes.includes("*")&&!req.auth?.scopes.includes(scope))return reply.code(403).send({error:{code:"INSUFFICIENT_SCOPE",message:`Required scope: ${scope}`}});};}
export function requireRole(role:Role){return async(req:FastifyRequest,reply:FastifyReply)=>{await authenticate(req,reply);if(reply.sent)return;if(!req.auth||!roleAllows(req.auth.role,role))return reply.code(403).send({error:{code:"FORBIDDEN",message:"Insufficient role"}});};}
export async function authPlugin(app:FastifyInstance){app.decorateRequest("auth",undefined);}
