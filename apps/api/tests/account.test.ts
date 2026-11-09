import { describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { app, login, PASSWORD, registerVerified } from "./helpers";
import { bearer } from "./groupHelpers";

const NEW_PASSWORD = "BrandNewPass77";
const change = (token: string, body: Record<string, unknown>, cookie?: string) => {
  const r = request(app).post("/api/auth/change-password").set(bearer(token));
  return (cookie ? r.set("Cookie", cookie) : r).send(body);
};

describe("profile", () => {
  it("updates the name only: email, role and status in the body are ignored", async () => {
    const email = await registerVerified();
    const s = await login(email);
    const res = await request(app)
      .patch("/api/auth/profile")
      .set(bearer(s.accessToken))
      .send({ name: "  New Name ", email: "evil@test.local", role: "PRESIDENT", isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: "New Name", email });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: s.userId } });
    expect(row.email).toBe(email);
    expect(row.isActive).toBe(true);
    expect(await prisma.auditLog.count({ where: { actorId: s.userId, action: "PROFILE_UPDATED" } })).toBe(1);
  });

  it("validates the name and requires login", async () => {
    const s = await login(await registerVerified());
    expect((await request(app).patch("/api/auth/profile").set(bearer(s.accessToken)).send({ name: "x" })).status).toBe(400);
    expect((await request(app).patch("/api/auth/profile").send({ name: "Valid Name" })).status).toBe(401);
  });
});

describe("change password", () => {
  it("changes it, keeps THIS session, and logs out the other sessions", async () => {
    const email = await registerVerified();
    const a = await login(email);
    const b = await login(email); // another device

    const res = await change(a.accessToken, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, a.refreshCookie);
    expect(res.status).toBe(200);

    expect((await request(app).post("/api/auth/refresh").set("Cookie", b.refreshCookie)).status).toBe(401);
    expect((await request(app).post("/api/auth/refresh").set("Cookie", a.refreshCookie)).status).toBe(200);
    expect((await request(app).post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email, password: NEW_PASSWORD })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { actorId: a.userId, action: "PASSWORD_CHANGED" } })).toBe(1);
  });

  it("refuses a wrong current password with 400 (not 401) and changes nothing", async () => {
    const email = await registerVerified();
    const s = await login(email);
    const res = await change(s.accessToken, { currentPassword: "WrongPassword1", newPassword: NEW_PASSWORD }, s.refreshCookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CURRENT_PASSWORD");
    expect((await request(app).post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
  });

  it("refuses an unchanged or weak new password", async () => {
    const s = await login(await registerVerified());
    const same = await change(s.accessToken, { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe("PASSWORD_UNCHANGED");
    expect((await change(s.accessToken, { currentPassword: PASSWORD, newPassword: "short" })).status).toBe(400);
  });

  it("requires login", async () => {
    const res = await request(app).post("/api/auth/change-password").send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });
});
