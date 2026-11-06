import { describe, it, expect } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { app, login, lastTokenFor, PASSWORD, refreshCookieOf, registerVerified, uniqueEmail } from "./helpers";

describe("registration", () => {
  it("rejects a weak password", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Weak", email: uniqueEmail(), password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("treats a duplicate email exactly like a new one (no enumeration)", async () => {
    const email = uniqueEmail();
    const body = { name: "Dup", email, password: PASSWORD };
    const first = await request(app).post("/api/auth/register").send(body);
    const second = await request(app).post("/api/auth/register").send(body);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it("blocks login until the email is verified", async () => {
    const email = uniqueEmail();
    await request(app).post("/api/auth/register").send({ name: "Unverified", email, password: PASSWORD });
    const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("verification links work once only", async () => {
    const email = uniqueEmail();
    await request(app).post("/api/auth/register").send({ name: "Once", email, password: PASSWORD });
    const token = lastTokenFor(email);
    await request(app).post("/api/auth/verify-email").send({ token }).expect(200);
    await request(app).post("/api/auth/verify-email").send({ token }).expect(400);
  });
});

describe("login", () => {
  it("returns an access token and a hardened refresh cookie", async () => {
    const email = await registerVerified();
    const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf("string");
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/auth");
  });

  it("gives the same answer for wrong password and unknown email", async () => {
    const email = await registerVerified();
    const wrong = await request(app).post("/api/auth/login").send({ email, password: "WrongPassword1" });
    const unknown = await request(app).post("/api/auth/login").send({ email: uniqueEmail(), password: "WrongPassword1" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("refuses requests from a foreign Origin", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://evil.example")
      .send({ email: uniqueEmail(), password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("BAD_ORIGIN");
  });

  it("stores only a hash of the refresh token", async () => {
    const email = await registerVerified();
    const session = await login(email);
    const raw = session.refreshCookie.split("=")[1];
    const rows = await prisma.refreshToken.findMany({ where: { userId: session.userId } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tokenHash !== raw)).toBe(true);
  });
});

describe("/me", () => {
  it("requires a token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns the user and no group yet", async () => {
    const email = await registerVerified();
    const { accessToken } = await login(email);
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(res.body.membership).toBeNull();
  });
});

describe("refresh tokens", () => {
  it("rotates, and a replayed old token kills the whole session", async () => {
    const email = await registerVerified();
    const first = await login(email);

    const r1 = await request(app).post("/api/auth/refresh").set("Cookie", first.refreshCookie);
    expect(r1.status).toBe(200);
    const second = refreshCookieOf(r1);
    expect(second).not.toBe(first.refreshCookie);

    // Someone replays the OLD token: treated as theft...
    const replay = await request(app).post("/api/auth/refresh").set("Cookie", first.refreshCookie);
    expect(replay.status).toBe(401);

    // ...so even the legitimate NEW token is now revoked.
    const after = await request(app).post("/api/auth/refresh").set("Cookie", second);
    expect(after.status).toBe(401);
  });

  it("logout revokes the session", async () => {
    const email = await registerVerified();
    const { refreshCookie } = await login(email);
    await request(app).post("/api/auth/logout").set("Cookie", refreshCookie).expect(204);
    await request(app).post("/api/auth/refresh").set("Cookie", refreshCookie).expect(401);
  });

  it("rejects a refresh with no cookie", async () => {
    await request(app).post("/api/auth/refresh").expect(401);
  });
});

describe("password reset", () => {
  it("resets the password, logs out all sessions, and the link is single-use", async () => {
    const email = await registerVerified();
    const session = await login(email);

    await request(app).post("/api/auth/forgot-password").send({ email }).expect(202);
    const token = lastTokenFor(email);

    const newPassword = "BrandNewPass77";
    await request(app).post("/api/auth/reset-password").send({ token, password: newPassword }).expect(200);

    await request(app).post("/api/auth/login").send({ email, password: PASSWORD }).expect(401);
    await request(app).post("/api/auth/login").send({ email, password: newPassword }).expect(200);
    await request(app).post("/api/auth/refresh").set("Cookie", session.refreshCookie).expect(401);
    await request(app).post("/api/auth/reset-password").send({ token, password: "AnotherPass88" }).expect(400);
  });

  it("answers the same for an unknown email", async () => {
    await request(app).post("/api/auth/forgot-password").send({ email: uniqueEmail() }).expect(202);
  });
});
