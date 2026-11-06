import crypto from "node:crypto";
import { env } from "../config/env";

// AES-256-GCM: encrypts AND detects tampering. Stored as  v1:iv:tag:ciphertext
const key = Buffer.from(env.DATA_ENCRYPTION_KEY, "hex");

export function encryptField(plain: string): string {
  const iv = crypto.randomBytes(12); // a fresh random IV for every value
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptField(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) {
    throw new Error("Unsupported ciphertext format");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
