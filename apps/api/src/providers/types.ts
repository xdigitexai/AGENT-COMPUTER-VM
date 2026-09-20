import type { ComputerMetrics, ProviderComputer } from "@xdigitex/contracts";

export type ProviderCapability = "COMPUTE_CREATE"|"START"|"STOP"|"RESTART"|"SUSPEND"|"METRICS"|"EXEC"|"PERSISTENT_STORAGE"|"SNAPSHOT"|"RESIZE"|"CONSOLE";
export interface CreateComputerInput { id: string; ownerId: string; organizationId: string; name: string; hostname: string; image: string; vcpu: number; ramMb: number; storageGb: number; sshPublicKey?: string; cloudInitUserData: string; }
export interface ResizeInput { vcpu?: number; ramMb?: number; storageGb?: number; }
export interface HostResources { cpuTotal: number; cpuUsed?: number; ramTotalMb: number; ramUsedMb?: number; storageTotalGb?: number; storageUsedGb?: number; providerVersion?: string; runningManaged?: number; stoppedManaged?: number; }
export interface ProviderHealth { ok: boolean; message?: string; }
export interface ConsoleSession { url: string; token: string; expiresAt: Date; }
export interface ExecuteInput { executable:string; arguments:string[]; timeoutMs:number; outputLimitBytes:number; }
export interface ExecuteResult { exitCode:number; stdout:string; stderr:string; truncated:boolean; startedAt:Date; completedAt:Date; }
export interface ManagedComputerResource { providerInstanceId:string; computerId:string; status:ProviderComputer["status"]; }
export interface VirtualizationProvider {
  readonly type: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  createComputer(input: CreateComputerInput): Promise<ProviderComputer>;
  startComputer(id: string): Promise<void>;
  stopComputer(id: string): Promise<void>;
  restartComputer(id: string): Promise<void>;
  suspendComputer(id: string): Promise<void>;
  resumeComputer(id: string): Promise<void>;
  deleteComputer(id: string): Promise<void>;
  getComputer(id: string): Promise<ProviderComputer | null>;
  getComputerStatus(id: string): Promise<ProviderComputer["status"]>;
  getMetrics(id: string): Promise<ComputerMetrics>;
  createSnapshot(id: string, name: string): Promise<string>;
  restoreSnapshot(id: string, snapshotId: string): Promise<void>;
  deleteSnapshot(id: string, snapshotId: string): Promise<void>;
  resizeComputer(id: string, input: ResizeInput): Promise<void>;
  listHostResources(): Promise<HostResources>;
  createConsoleSession(id: string): Promise<ConsoleSession>;
  executeCommand?(id:string,input:ExecuteInput):Promise<ExecuteResult>;
  listManagedComputers?():Promise<ManagedComputerResource[]>;
  healthCheck(): Promise<ProviderHealth>;
}
export class ProviderError extends Error { constructor(public code: string, message: string, public retryable = false) { super(message); } }
