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

// Agent lifecycle shared with the console: a run attaches to an existing computer, drives the
// visible desktop, and detaches without creating or deleting anything.
export const agentRunStates = [
  "QUEUED", "ATTACHED", "OBSERVING", "ACTING", "WAITING_FOR_HUMAN", "COMPLETED", "FAILED", "DETACHED"
] as const;
export type AgentRunState = typeof agentRunStates[number];
export const agentActionTypes = [
  "move", "click", "double_click", "right_click", "type", "key", "scroll", "drag",
  "browser_navigate", "browser_open_tab", "browser_click", "browser_type", "browser_press",
  "browser_evaluate", "focus_browser", "open_terminal", "visible_command", "terminal_command",
  "screenshot", "wait"
] as const;
export type AgentActionType = typeof agentActionTypes[number];
export interface AgentControllerState { controller: "agent" | "human"; holderId: string | null; holderEmail: string | null; since: string | null; expiresInSeconds: number | null; }
export interface AgentSessionState { attached: boolean; agentRunId: string | null; agentName: string | null; status: AgentRunState | null; phase: string | null; waitingForHuman: boolean; title: string | null; }
export interface ActivityEventView { id: string; computerId: string; agentRunId: string | null; kind: string; message: string; severity: string; metadata: unknown; createdAt: string; }
