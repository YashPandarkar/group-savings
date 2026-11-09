import crypto from "node:crypto";

export const hmacSha256Hex = (secret: string, data: string | Buffer): string =>
  crypto.createHmac("sha256", secret).update(data).digest("hex");

// Constant-time comparison, so response timing can't leak how much of a signature matched.
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
