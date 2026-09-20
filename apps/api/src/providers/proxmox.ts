import type { ComputerState } from "@xdigitex/contracts";
import { ProviderError, type ConsoleSession, type CreateComputerInput, type HostResources, type ProviderHealth, type ResizeInput, type VirtualizationProvider } from "./types.js";

interface ProxmoxConfig { endpoint: string; node: string; tokenId: string; tokenSecret: string; storage: string; bridge: string; verifyTls?: boolean; }
export class ProxmoxProvider implements VirtualizationProvider {
  readonly type = "proxmox";
  constructor(private readonly config: ProxmoxConfig) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`${this.config.endpoint.replace(/\/$/, "")}/api2/json${path}`, { ...init, signal: controller.signal, headers: { Authorization: `PVEAPIToken=${this.config.tokenId}=${this.config.tokenSecret}`, "Content-Type": "application/x-www-form-urlencoded", ...init.headers } });
      if (response.status === 401 || response.status === 403) throw new ProviderError("AUTHENTICATION_FAILED", "Provider authentication failed");
      if (!response.ok) throw new ProviderError("OPERATION_FAILED", `Provider returned HTTP ${response.status}`, response.status >= 500);
      const body = await response.json() as { data: T }; return body.data;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "Provider unavailable", true);
    } finally { clearTimeout(timeout); }
  }
  private form(values: Record<string,string|number|boolean|undefined>) { const p = new URLSearchParams(); for (const [k,v] of Object.entries(values)) if (v !== undefined) p.set(k,String(v)); return p; }
  private vmid(id: string) { const value = Number(id); if (!Number.isInteger(value)) throw new ProviderError("OPERATION_FAILED", "Invalid provider VM identifier"); return value; }
  private async waitForTask(upid:string){
    const deadline=Date.now()+120_000;
    while(Date.now()<deadline){
      const task=await this.request<{status:string;exitstatus?:string}>(`/nodes/${encodeURIComponent(this.config.node)}/tasks/${encodeURIComponent(upid)}/status`);
      if(task.status==="stopped"){
        if(task.exitstatus&&task.exitstatus!=="OK")throw new ProviderError("OPERATION_FAILED",`Provider task failed: ${task.exitstatus}`);
        return;
      }
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new ProviderError("PROVIDER_UNAVAILABLE","Provider task timed out",true);
  }
  async createComputer(input: CreateComputerInput) {
    const vmid = await this.request<number>("/cluster/nextid");
    const templateId=this.vmid(input.image);
    const cloneTask=await this.request<string>(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${templateId}/clone`,{method:"POST",body:this.form({newid:vmid,name:input.hostname,full:1,storage:this.config.storage})});
    await this.waitForTask(cloneTask);
    const configureTask=await this.request<string>(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${vmid}/config`, { method:"PUT", body:this.form({ cores:input.vcpu, memory:input.ramMb, scsihw:"virtio-scsi-pci", net0:`virtio,bridge=${this.config.bridge}`, ciuser:"agent", sshkeys:input.sshPublicKey, ipconfig0:"ip=dhcp", agent:1, onboot:0 }) });
    if(configureTask)await this.waitForTask(configureTask);
    const resizeTask=await this.request<string>(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${vmid}/resize`,{method:"PUT",body:this.form({disk:"scsi0",size:`${input.storageGb}G`})});
    if(resizeTask)await this.waitForTask(resizeTask);
    return { providerInstanceId:String(vmid), status:"PROVISIONING" as const };
  }
  private async action(id:string, action:string) { await this.request(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${this.vmid(id)}/status/${action}`, { method:"POST", body:this.form({}) }); }
  startComputer=(id:string)=>this.action(id,"start"); stopComputer=(id:string)=>this.action(id,"shutdown"); restartComputer=(id:string)=>this.action(id,"reboot"); suspendComputer=(id:string)=>this.action(id,"suspend"); resumeComputer=(id:string)=>this.action(id,"resume");
  async deleteComputer(id:string) { await this.request(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${this.vmid(id)}`, { method:"DELETE" }); }
  async getComputer(id:string) { const d=await this.request<any>(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${this.vmid(id)}/status/current`); return { providerInstanceId:id, status:this.mapStatus(d.status), uptimeSeconds:d.uptime }; }
  async getComputerStatus(id:string) { return (await this.getComputer(id))!.status; }
  async getMetrics(id:string) { const d=await this.request<any>(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${this.vmid(id)}/status/current`); return { observedAt:new Date(), cpuPercent:d.cpu == null ? undefined : d.cpu*100, memoryUsedBytes:d.mem == null ? undefined : BigInt(d.mem), memoryTotalBytes:d.maxmem == null ? undefined : BigInt(d.maxmem), diskUsedBytes:d.disk == null ? undefined : BigInt(d.disk), diskTotalBytes:d.maxdisk == null ? undefined : BigInt(d.maxdisk), networkRxBytes:d.netin == null ? undefined : BigInt(d.netin), networkTxBytes:d.netout == null ? undefined : BigInt(d.netout), uptimeSeconds:d.uptime }; }
  async createSnapshot(id:string,name:string) { await this.request(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${this.vmid(id)}/snapshot`,{method:"POST",body:this.form({snapname:name})}); return name; }
  async restoreSnapshot(id:string,snapshotId:string) { await this.request(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${this.vmid(id)}/snapshot/${encodeURIComponent(snapshotId)}/rollback`,{method:"POST",body:this.form({})}); }
  async deleteSnapshot(id:string,snapshotId:string) { await this.request(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${this.vmid(id)}/snapshot/${encodeURIComponent(snapshotId)}`,{method:"DELETE"}); }
  async resizeComputer(id:string,input:ResizeInput) { await this.request(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${this.vmid(id)}/config`,{method:"PUT",body:this.form({cores:input.vcpu,memory:input.ramMb,scsi0:input.storageGb?`${this.config.storage}:${input.storageGb}`:undefined})}); }
  async listHostResources():Promise<HostResources> { const d=await this.request<any>(`/nodes/${encodeURIComponent(this.config.node)}/status`); return {cpuTotal:d.cpuinfo?.cpus??0,cpuUsed:(d.cpu??0)*(d.cpuinfo?.cpus??0),ramTotalMb:Math.floor((d.memory?.total??0)/1048576),ramUsedMb:Math.floor((d.memory?.used??0)/1048576),storageTotalGb:Math.floor((d.rootfs?.total??0)/1073741824),storageUsedGb:Math.floor((d.rootfs?.used??0)/1073741824)}; }
  async createConsoleSession(id:string):Promise<ConsoleSession> { const d=await this.request<any>(`/nodes/${encodeURIComponent(this.config.node)}/qemu/${this.vmid(id)}/vncproxy`,{method:"POST",body:this.form({websocket:1})}); return {url:`${this.config.endpoint}/api2/json/nodes/${this.config.node}/qemu/${id}/vncwebsocket?port=${d.port}&vncticket=${encodeURIComponent(d.ticket)}`,token:d.ticket,expiresAt:new Date(Date.now()+60_000)}; }
  async healthCheck():Promise<ProviderHealth> { try { await this.request(`/nodes/${encodeURIComponent(this.config.node)}/status`); return {ok:true}; } catch(e) { return {ok:false,message:e instanceof Error?e.message:"Provider unavailable"}; } }
  private mapStatus(status:string):ComputerState { return status === "running" ? "RUNNING" : status === "stopped" ? "STOPPED" : "PROVIDER_UNAVAILABLE"; }
}
