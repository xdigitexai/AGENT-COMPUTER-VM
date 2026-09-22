import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import { authenticate, authPlugin } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { computerRoutes } from "./routes/computers.js";
import { resourceRoutes } from "./routes/resources.js";
import { adminRoutes } from "./routes/admin.js";
import { healthRoutes } from "./routes/health.js";
import { desktopRoutes } from "./routes/desktop.js";
import { agentCatalogRoutes, agentRoutes } from "./routes/agent.js";
import { ControlLock } from "./services/control.js";
import { ActivityHub } from "./services/activity.js";
import { createAgentQueue, createInfrastructureQueue } from "./queue.js";
import { prisma } from "./db.js";

// Prisma maps 64-bit integer columns (metrics, uptime, usage) to BigInt, and JSON.stringify
// throws "Do not know how to serialize a BigInt". Without this, a successful operation is
// returned as HTTP 500 during response serialization.
(BigInt.prototype as unknown as {toJSON:()=>number}).toJSON=function(this:bigint){return Number(this)};
const config=loadConfig();const app=Fastify({logger:{level:config.LOG_LEVEL,redact:["req.headers.authorization","req.headers.cookie","password","token","secret","credential","encryptedValue"]},trustProxy:config.TRUST_PROXY==="true",bodyLimit:1024*1024});const queue=createInfrastructureQueue(config);
await app.register(helmet,{contentSecurityPolicy:false});await app.register(cors,{origin:config.WEB_ORIGIN,credentials:true});await app.register(cookie,{secret:config.SESSION_SECRET});await app.register(rateLimit,{max:120,timeWindow:"1 minute"});await app.register(websocket);await app.register(authPlugin);
app.setErrorHandler((error,req,reply)=>{if(error instanceof ZodError)return reply.code(400).send({error:{code:"VALIDATION_ERROR",message:"Invalid request",details:error.flatten()}});const status=(error as any).statusCode??500;req.log.error({err:error},"request failed");return reply.code(status).send({error:{code:(error as any).code??"INTERNAL_ERROR",message:status>=500?"Internal server error":(error as Error).message}});});
const control=new ControlLock(config);const activity=new ActivityHub(config);const agentQueue=createAgentQueue(config);
await app.register(authRoutes,{prefix:"/api/v1/auth"});
// Computers are exposed under the versioned API and, unchanged, under /api/computers.
await app.register(computerRoutes(queue,config),{prefix:"/api/v1/computers"});await app.register(computerRoutes(queue,config),{prefix:"/api/computers"});
await app.register(desktopRoutes(config,control,activity),{prefix:"/api/v1/computers"});await app.register(desktopRoutes(config,control,activity),{prefix:"/api/computers"});
// XDIGITEX Agent API: attach to an existing computer, observe it, act on it, detach.
await app.register(agentRoutes(agentQueue,config,control,activity),{prefix:"/api/v1/computers"});await app.register(agentRoutes(agentQueue,config,control,activity),{prefix:"/api/computers"});
await app.register(agentCatalogRoutes(),{prefix:"/api/v1/agent"});
await app.register(resourceRoutes(queue,config),{prefix:"/api/v1"});await app.register(adminRoutes(config),{prefix:"/api/v1/admin"});await app.register(healthRoutes(queue,config));
// Authenticated event stream. Without a query it is a heartbeat channel; with ?computerId= it
// replays the recent live-activity panel history and then tails that computer's activity.
app.get("/api/v1/events",{websocket:true,preValidation:authenticate},async(socket,request)=>{const timer=setInterval(()=>socket.send(JSON.stringify({type:"heartbeat",at:new Date().toISOString()})),30000);let dispose:(()=>Promise<void>)|undefined;const computerId=(request.query as {computerId?:string}|undefined)?.computerId;if(computerId&&/^[0-9a-fA-F-]{36}$/.test(computerId)){const owned=await prisma.computer.findFirst({where:{id:computerId,organizationId:request.auth!.organizationId,deletedAt:null}});if(!owned)socket.send(JSON.stringify({type:"error",code:"NOT_FOUND",message:"AI Computer is not available"}));else{try{for(const event of await activity.recent(prisma,computerId,30))socket.send(JSON.stringify({type:"activity",event}));dispose=await activity.subscribe(computerId,event=>{try{socket.send(JSON.stringify({type:"activity",event}))}catch{/* viewer went away */}});}catch(error){console.error(JSON.stringify({event:"events.subscribe_failed",message:error instanceof Error?error.message:"unknown"}));}}}socket.on("close",()=>{clearInterval(timer);void dispose?.();});});

app.addHook("onClose",async()=>{await control.close();await activity.close();await agentQueue.close();await queue.close();await prisma.$disconnect();});
await app.listen({host:config.API_HOST,port:config.API_PORT});
