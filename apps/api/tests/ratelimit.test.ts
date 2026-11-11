import express from "express";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { makeEmailLimiter } from "../src/middleware/rateLimit";

// A tiny app: the "login" succeeds only when the body says ok:true.
function miniApp() {
  const a = express();
  a.use(express.json());
  a.post("/login", makeEmailLimiter({ limit: 3, windowMs: 60_000, skip: () => false }), (req, res) => {
    res.status((req.body as { ok?: boolean }).ok ? 200 : 401).json({});
  });
  return a;
}
const attempt = (a: express.Express, email: string, ok = false) => request(a).post("/login").send({ email, ok });

describe("per-email login limiter", () => {
  it("blocks the 4th failed attempt for the same email, however the address is written", async () => {
    const a = miniApp();
    for (let i = 0; i < 3; i++) expect((await attempt(a, "victim@example.com")).status).toBe(401);
    expect((await attempt(a, "victim@example.com")).status).toBe(429);
    expect((await attempt(a, "  VICTIM@Example.com ")).status).toBe(429);
  });

  it("other emails are unaffected", async () => {
    const a = miniApp();
    for (let i = 0; i < 4; i++) await attempt(a, "one@example.com");
    expect((await attempt(a, "two@example.com")).status).toBe(401);
  });

  it("successful logins are not counted", async () => {
    const a = miniApp();
    for (let i = 0; i < 6; i++) expect((await attempt(a, "busy@example.com", true)).status).toBe(200);
    expect((await attempt(a, "busy@example.com")).status).toBe(401); // the first failure still has room
  });
});
