import {describe,expect,it,vi} from "vitest";
import {enforceCreateQuota} from "../src/services/quotas.js";
const plan={id:"plan",enabled:true,computerLimit:2,cpuAllowance:4,ramAllowanceMb:8192,storageAllowanceGb:100};
describe("quota enforcement",()=>{
  it("accepts resources within the server-side entitlement",async()=>{const db:any={computePlan:{findUnique:vi.fn().mockResolvedValue(plan)},computer:{aggregate:vi.fn().mockResolvedValue({_count:1,_sum:{vcpu:1,ramMb:2048,storageGb:20}})}};await expect(enforceCreateQuota(db,"org","plan",{vcpu:2,ramMb:4096,storageGb:40})).resolves.toBeUndefined()});
  it("rejects allocation above plan limits",async()=>{const db:any={computePlan:{findUnique:vi.fn().mockResolvedValue(plan)},computer:{aggregate:vi.fn().mockResolvedValue({_count:2,_sum:{vcpu:2,ramMb:4096,storageGb:40}})}};await expect(enforceCreateQuota(db,"org","plan",{vcpu:1,ramMb:1024,storageGb:10})).rejects.toMatchObject({code:"QUOTA_EXCEEDED"})});
});
