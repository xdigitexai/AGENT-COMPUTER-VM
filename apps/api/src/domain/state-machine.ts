import type { ComputerStatus } from "@prisma/client";

export type LifecycleAction = "provision" | "start" | "stop" | "restart" | "suspend" | "resume" | "delete";
const transitions: Record<LifecycleAction, Partial<Record<ComputerStatus, ComputerStatus>>> = {
  provision: { CREATING: "PROVISIONING", ERROR: "PROVISIONING", PROVIDER_UNAVAILABLE: "PROVISIONING" },
  start: { STOPPED: "STARTING", SUSPENDED: "STARTING", PROVIDER_UNAVAILABLE: "STARTING" },
  stop: { RUNNING: "STOPPING" },
  restart: { RUNNING: "REBOOTING" },
  suspend: { RUNNING: "SUSPENDING" },
  resume: { SUSPENDED: "STARTING" },
  delete: { CREATING: "DELETING", STOPPED: "DELETING", SUSPENDED: "DELETING", ERROR: "DELETING", PROVIDER_UNAVAILABLE: "DELETING" }
};
export function transition(status: ComputerStatus, action: LifecycleAction): ComputerStatus {
  const next = transitions[action][status];
  if (!next) throw Object.assign(new Error(`Cannot ${action} a computer in ${status}`), { statusCode: 409, code: "INVALID_STATE_TRANSITION" });
  return next;
}
export function allowedActions(status: ComputerStatus): LifecycleAction[] {
  return (Object.keys(transitions) as LifecycleAction[]).filter(action => Boolean(transitions[action][status]));
}
