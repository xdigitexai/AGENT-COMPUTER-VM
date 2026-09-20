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
import { createInfrastructureQueue } from "./queue.js";
import { prisma } from "./db.js";

// Prisma maps 64-bit integer columns (metrics, uptime, usage) to BigInt, and JSON.stringify
// throws "Do not know how to serialize a BigInt". Without this, a successful operation is
// returned as HTTP 500 during response serialization.
(BigInt.prototype as unknown as {toJSON:()=>number}).toJSON=function(this:bigint){return Number(this)};
const config=loadConfig();const app=Fastify({logger:{level:config.LOG_LEVEL,redact:["req.headers.authorization","req.headers.cookie","password","token","secret","credential","encryptedValue"]},trustProxy:config.TRUST_PROXY==="true",bodyLimit:1024*1024});const queue=createInfrastructureQueue(config);
await app.register(helmet,{contentSecurityPolicy:false});await app.register(cors,{origin:config.WEB_ORIGIN,credentials:true});await app.register(cookie,{secret:config.SESSION_SECRET});await app.register(rateLimit,{max:120,timeWindow:"1 minute"});await app.register(websocket);await app.register(authPlugin);
await app.register(authRoutes,{prefix:"/api/v1/auth"});await app.register(computerRoutes(queue),{prefix:"/api/v1/computers"});await app.register(resourceRoutes(queue,config),{prefix:"/api/v1"});await app.register(adminRoutes(config),{prefix:"/api/v1/admin"});await app.register(healthRoutes(queue));
app.get("/api/v1/events",{websocket:true,preValidation:authenticate},socket=>{const timer=setInterval(()=>socket.send(JSON.stringify({type:"heartbeat",at:new Date().toISOString()})),30000);socket.on("close",()=>clearInterval(timer));});
app.setErrorHandler((error,req,reply)=>{if(error instanceof ZodError)return reply.code(400).send({error:{code:"VALIDATION_ERROR",message:"Invalid request",details:error.flatten()}});const status=(error as any).statusCode??500;req.log.error({err:error},"request failed");return reply.code(status).send({error:{code:(error as any).code??"INTERNAL_ERROR",message:status>=500?"Internal server error":(error as Error).message}});});
app.addHook("onClose",async()=>{await queue.close();await prisma.$disconnect();});
await app.listen({host:config.API_HOST,port:config.API_PORT});
