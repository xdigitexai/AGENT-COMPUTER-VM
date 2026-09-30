import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireScope } from "../auth.js";
import { providerFor } from "../providers/factory.js";
import type { Config } from "../config.js";
import { openWebSocket, type SocketLike } from "../services/desktop.js";

const idSchema=z.object({id:z.string().uuid()});
const viewerParams=z.object({id:z.string().uuid(),token:z.string().min(20),"*":z.string().optional()});
type ViewerClaims={computerId:string;organizationId:string;exp:number};
type DesktopEndpoint={ipv4:string|null;port:number;cdpPort:number;websockifyUrl:string};
const b64=(value:string)=>Buffer.from(value,"utf8").toString("base64url");
const unb64=(value:string)=>Buffer.from(value,"base64url").toString("utf8");

function sign(config:Config,claims:ViewerClaims){
  const body=b64(JSON.stringify(claims));
  const signature=createHmac("sha256",config.SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}
function verify(config:Config,token:string):ViewerClaims|null{
  const [body,signature,...rest]=String(token).split(".");
  if(!body||!signature||rest.length)return null;
  const expected=createHmac("sha256",config.SESSION_SECRET).update(body).digest();
  let supplied:Buffer;try{supplied=Buffer.from(signature,"base64url");}catch{return null;}
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return null;
  try{const claims=JSON.parse(unb64(body)) as ViewerClaims;if(!claims?.computerId||!claims?.organizationId||!Number.isFinite(claims?.exp)||Date.now()>=claims.exp)return null;return claims;}catch{return null;}
}

function firstHeader(value:unknown){return String(value||"").split(",")[0]?.trim()||"";}
function publicOrigin(req:FastifyRequest){
  const forwardedProto=firstHeader(req.headers["x-forwarded-proto"]);
  const forwardedHost=firstHeader(req.headers["x-forwarded-host"]);
  const proto=forwardedProto||req.protocol||"https";
  const host=forwardedHost||req.headers.host||"";
  return `${proto}://${host}`;
}
function wsOrigin(httpOrigin:string){return httpOrigin.replace(/^http:/i,"ws:").replace(/^https:/i,"wss:");}

export function viewerRoutes(config:Config){return async(app:FastifyInstance)=>{
  app.post("/:id/viewer-session",{preHandler:requireScope("computer:console")},async(req,reply)=>{
    const {id}=idSchema.parse(req.params);
    const computer=await prisma.computer.findFirst({where:{id,organizationId:req.auth!.organizationId,deletedAt:null},include:{host:{include:{credential:true}}}});
    if(!computer||!computer.host||!computer.providerInstanceId)return reply.code(404).send({error:{code:"NOT_FOUND",message:"AI Computer is not available"}});
    if(computer.status!=="RUNNING")return reply.code(409).send({error:{code:"NOT_RUNNING",message:`AI Computer is ${computer.status}`}});
    const provider=providerFor(computer.host,config);
    if(!provider.getDesktopEndpoint)return reply.code(409).send({error:{code:"VIEWER_UNAVAILABLE",message:"Provider does not expose a desktop endpoint"}});
    const endpoint=await provider.getDesktopEndpoint(computer.providerInstanceId);
    if(!endpoint?.ipv4)return reply.code(409).send({error:{code:"VIEWER_UNAVAILABLE",message:"Desktop endpoint is not ready"}});
    const expiresAt=Date.now()+120_000;
    const token=sign(config,{computerId:id,organizationId:req.auth!.organizationId,exp:expiresAt});
    const base=`/api/v1/computers/${encodeURIComponent(id)}/viewer/${encodeURIComponent(token)}`;
    const path=`${base}/websockify`;
    const origin=publicOrigin(req);
    return {viewerUrl:`${origin}${base}/vnc.html?autoconnect=1&resize=scale&path=${encodeURIComponent(path.replace(/^\//,""))}`,websocketUrl:`${wsOrigin(origin)}${path}`,expiresAt:new Date(expiresAt).toISOString()};
  });

  const resolveViewer=async(req:FastifyRequest,reply?:FastifyReply):Promise<{params:z.infer<typeof viewerParams>;endpoint:DesktopEndpoint}|null>=>{
    const params=viewerParams.parse(req.params);const claims=verify(config,params.token);
    if(!claims||claims.computerId!==params.id){if(reply)await reply.code(401).send({error:{code:"VIEWER_TOKEN_INVALID",message:"Viewer session is invalid or expired"}});return null;}
    const computer=await prisma.computer.findFirst({where:{id:params.id,organizationId:claims.organizationId,deletedAt:null},include:{host:{include:{credential:true}}}});
    if(!computer||!computer.host||!computer.providerInstanceId){if(reply)await reply.code(404).send({error:{code:"NOT_FOUND",message:"AI Computer is not available"}});return null;}
    if(computer.status!=="RUNNING"){if(reply)await reply.code(409).send({error:{code:"NOT_RUNNING",message:`AI Computer is ${computer.status}`}});return null;}
    const provider=providerFor(computer.host,config);
    if(!provider.getDesktopEndpoint){if(reply)await reply.code(409).send({error:{code:"VIEWER_UNAVAILABLE",message:"Desktop endpoint is unavailable"}});return null;}
    const endpoint=await provider.getDesktopEndpoint(computer.providerInstanceId);
    if(!endpoint?.ipv4){if(reply)await reply.code(409).send({error:{code:"VIEWER_UNAVAILABLE",message:"Desktop endpoint is not ready"}});return null;}
    return {params,endpoint};
  };

  app.get("/:id/viewer/:token/websockify",{websocket:true},async(socket:SocketLike & {on(event:string,listener:(...args:any[])=>void):void},req:FastifyRequest)=>{
    const resolved=await resolveViewer(req);if(!resolved)return socket.close(4401,"Viewer session is invalid or expired");
    let upstream:SocketLike;try{upstream=openWebSocket(resolved.endpoint.websockifyUrl,["binary"]);}catch{return socket.close(4503,"Desktop stream could not be opened");}
    upstream.binaryType="arraybuffer";const pending:unknown[]=[];let ready=false;
    const close=(code:number,reason:string)=>{try{socket.close(code,reason);}catch{}try{upstream.close();}catch{}};
    upstream.addEventListener("open",()=>{ready=true;for(const frame of pending)upstream.send(frame);pending.length=0;});
    upstream.addEventListener("message",event=>{if(socket.readyState===1&&event.data)socket.send(Buffer.from(event.data as ArrayBuffer));});
    upstream.addEventListener("close",()=>close(1011,"Desktop stream closed"));upstream.addEventListener("error",()=>close(1011,"Desktop stream error"));
    socket.on("message",(data:unknown)=>{if(ready)upstream.send(data);else pending.push(data);});socket.on("close",()=>{try{upstream.close();}catch{}});socket.on("error",()=>{try{upstream.close();}catch{}});
  });

  app.get("/:id/viewer/:token/*",async(req,reply)=>{
    const resolved=await resolveViewer(req,reply);if(!resolved)return;
    const asset=resolved.params["*"]||"vnc.html";
    if(asset.includes(".."))return reply.code(400).send({error:{code:"INVALID_PATH",message:"Invalid viewer asset path"}});
    const upstream=await fetch(`http://${resolved.endpoint.ipv4}:${resolved.endpoint.port}/${asset}`,{headers:{accept:String(req.headers.accept||"*/*")}});
    if(!upstream.ok)return reply.code(upstream.status).send(await upstream.text());
    const contentType=upstream.headers.get("content-type");if(contentType)reply.header("content-type",contentType);
    reply.header("cache-control",asset==="vnc.html"?"no-store":"private, max-age=300");
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  });
};}
