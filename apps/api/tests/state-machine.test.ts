import { describe,expect,it } from "vitest";
import { allowedActions,transition } from "../src/domain/state-machine.js";
describe("computer lifecycle",()=>{
  it("prevents conflicting operations",()=>{expect(()=>transition("STARTING","stop")).toThrow(/Cannot stop/);expect(()=>transition("RUNNING","start")).toThrow(/Cannot start/)});
  it("keeps stop distinct from delete",()=>{expect(transition("RUNNING","stop")).toBe("STOPPING");expect(allowedActions("STOPPED")).toContain("delete")});
  it("supports recovery from provider unavailability",()=>{expect(transition("PROVIDER_UNAVAILABLE","start")).toBe("STARTING");expect(transition("PROVIDER_UNAVAILABLE","delete")).toBe("DELETING")});
});
