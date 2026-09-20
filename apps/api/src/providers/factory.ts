import type { ComputeHost, ProviderCredential } from "@prisma/client";
import type { Config } from "../config.js";
import { decryptSecret } from "../security/crypto.js";
import { ProxmoxProvider } from "./proxmox.js";
import { ProviderError, type VirtualizationProvider } from "./types.js";

export function providerFor(host: ComputeHost & { credential: ProviderCredential | null }, config: Config): VirtualizationProvider {
  if (!host.credential) throw new ProviderError("HOST_NOT_CONFIGURED", "Provider credentials are not configured");
  let credential: Record<string,string>;
  try { credential = JSON.parse(decryptSecret(host.credential.encryptedValue, config.ENCRYPTION_KEY)); }
  catch { throw new ProviderError("HOST_NOT_CONFIGURED", "Provider credential cannot be decrypted"); }
  if (host.provider.toLowerCase() === "proxmox") return new ProxmoxProvider({ endpoint:host.endpoint,node:host.node,tokenId:credential.tokenId ?? "",tokenSecret:credential.tokenSecret ?? "",storage:credential.storage ?? "local-lvm",bridge:credential.bridge ?? "vmbr0" });
  throw new ProviderError("HOST_NOT_CONFIGURED", `Unsupported provider: ${host.provider}`);
}
