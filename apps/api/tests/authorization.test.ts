import {describe,expect,it} from "vitest";
import {roleAllows,tenantAllows} from "../src/auth.js";
describe("authorization",()=>{
  it("enforces role hierarchy for dangerous admin actions",()=>{expect(roleAllows("USER","ADMIN")).toBe(false);expect(roleAllows("ORG_ADMIN","ADMIN")).toBe(false);expect(roleAllows("SUPER_ADMIN","ADMIN")).toBe(true)});
  it("isolates tenants while allowing global administrators",()=>{const memberships=[{organizationId:"tenant-a"}];expect(tenantAllows("tenant-a",memberships,"USER")).toBe(true);expect(tenantAllows("tenant-b",memberships,"USER")).toBe(false);expect(tenantAllows("tenant-b",memberships,"ADMIN")).toBe(true)});
});
