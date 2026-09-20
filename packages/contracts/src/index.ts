export const computerStates = [
  "CREATING", "PROVISIONING", "RUNNING", "STOPPING", "STOPPED", "SUSPENDING",
  "SUSPENDED", "STARTING", "REBOOTING", "DELETING", "DELETED", "ERROR",
  "PROVIDER_UNAVAILABLE"
] as const;
export type ComputerState = typeof computerStates[number];
export const apiKeyScopes = [
  "computer:read", "computer:create", "computer:start", "computer:stop",
  "computer:delete", "computer:console", "computer:agent"
] as const;
export type ApiKeyScope = typeof apiKeyScopes[number];
export type ProviderErrorCode = "HOST_NOT_CONFIGURED" | "PROVIDER_UNAVAILABLE" | "AUTHENTICATION_FAILED" | "INSUFFICIENT_CAPACITY" | "OPERATION_FAILED";
export interface ProviderComputer { providerInstanceId: string; status: ComputerState; ipv4?: string; ipv6?: string; uptimeSeconds?: number; }
export interface ComputerMetrics { observedAt: Date; cpuPercent?: number; memoryUsedBytes?: bigint; memoryTotalBytes?: bigint; diskUsedBytes?: bigint; diskTotalBytes?: bigint; networkRxBytes?: bigint; networkTxBytes?: bigint; uptimeSeconds?: number; }
