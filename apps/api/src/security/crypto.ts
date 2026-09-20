import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newOpaqueToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);
export const constantTimeTokenMatch = (actualHash: string, token: string) => {
  const expected = Buffer.from(actualHash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
function key(input: string) { return createHash("sha256").update(input).digest(); }
export function encryptSecret(value: string, encryptionKey: string) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(encryptionKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
export function decryptSecret(value: string, encryptionKey: string) {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unsupported encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key(encryptionKey), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
