import crypto from "node:crypto";

// Fast one-way hash. Fine for long random tokens (NOT for passwords).
export const sha256 = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

// 256 bits of randomness, URL-safe.
export const newOpaqueToken = () => crypto.randomBytes(32).toString("base64url");
