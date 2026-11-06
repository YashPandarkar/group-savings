import { beforeAll, describe, expect, it } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { ALL_PERMISSIONS, can } from "../src/lib/permissions";
import { errorHandler } from "../src/middleware/errorHandler";
import { requireAuth } from "../src/middleware/requireAuth";
import { requireGroupMember } from "../src/middleware/requireGroupMember";
import { requirePermission } from "../src/middleware/requirePermission";
import { login, registerVerified } from "./helpers";

describe("permission matrix", () => {
  it("members cannot withdraw, approve loans or manage the group", () => {
    for (const p of ["withdrawal:request", "withdrawal:approve", "loan:approve", "loan:disburse", "member:change_role", "audit:view"] as const) {
      expect(can("MEMBER", p)).toBe(false);
    }
  });

  it("members can do the basics", () => {
    for (const p of ["deposit:create", "loan:apply", "loan:repay", "balance:view"] as const) {
      expect(can("MEMBER", p)).toBe(true);
    }
  });

  it("President and Vice President can withdraw; only the President approves loans", () => {
    expect(can("PRESIDENT", "withdrawal:request")).toBe(true);
    expect(can("VICE_PRESIDENT", "withdrawal:request")).toBe(true);
    expect(can("PRESIDENT", "loan:approve")).toBe(true);
    expect(can("VICE_PRESIDENT", "loan:approve")).toBe(false);
    expect(can("VICE_PRESIDENT", "loan:review")).toBe(true);
  });

  it("roles are strictly nested: MEMBER ⊂ VICE_PRESIDENT ⊂ PRESIDENT", () => {
    for (const p of ALL_PERMISSIONS) {
      if (can("MEMBER", p)) expect(can("VICE_PRESIDENT", p)).toBe(true);
      if (can("VICE_PRESIDENT", p)) expect(can("PRESIDENT", p)).toBe(true);
      expect(can("PRESIDENT", p)).toBe(true);
    }
  });
});

// A tiny app with the real middleware chain, so we can attack it.
const probe = express();
probe.use(express.json());
probe.get("/groups/:groupId/ping", requireAuth, requireGroupMember, (req, res) => {
  res.json({ role: req.membership!.role });
});
probe.post(
  "/groups/:groupId/withdrawals",
  requireAuth,
  requireGroupMember,
  requirePermission("withdrawal:request"),
  (_req, res) => res.status(201).json({ ok: true })
);
probe.use(errorHandler);

describe("middleware chain", () => {
  let groupA = "";
  let groupB = "";
  let president: { accessToken: string; userId: string };
  let member: { accessToken: string; userId: string };
  let outsider: { accessToken: string; userId: string };

  const makeGroup = (createdById: string) =>
    prisma.group.create({
      data: { name: "Test Group", monthlyContributionPaise: 20000n, maxMembers: 10, createdById },
    });

  beforeAll(async () => {
    president = await login(await registerVerified());
    member = await login(await registerVerified());
    outsider = await login(await registerVerified());

    const a = await makeGroup(president.userId);
    const b = await makeGroup(outsider.userId);
    groupA = a.id;
    groupB = b.id;

    await prisma.groupMember.createMany({
      data: [
        { groupId: a.id, userId: president.userId, role: "PRESIDENT" },
        { groupId: a.id, userId: member.userId, role: "MEMBER" },
        { groupId: b.id, userId: outsider.userId, role: "PRESIDENT" },
      ],
    });
  });

  const get = (token: string | null, groupId: string) => {
    const r = request(probe).get(`/groups/${groupId}/ping`);
    return token ? r.set("Authorization", `Bearer ${token}`) : r;
  };
  const withdraw = (token: string, groupId: string) =>
    request(probe).post(`/groups/${groupId}/withdrawals`).set("Authorization", `Bearer ${token}`).send({});

  it("rejects requests without a token", async () => {
    expect((await get(null, groupA)).status).toBe(401);
  });

  it("lets a member into their own group", async () => {
    const res = await get(member.accessToken, groupA);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("MEMBER");
  });

  it("GROUP ISOLATION: another group's President gets 404 on this group", async () => {
    const res = await get(outsider.accessToken, groupA);
    expect(res.status).toBe(404);
  });

  it("a member calling a withdrawal API directly gets 403", async () => {
    const res = await withdraw(member.accessToken, groupA);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("the President is allowed", async () => {
    expect((await withdraw(president.accessToken, groupA)).status).toBe(201);
  });

  it("a President of ANOTHER group cannot withdraw from this one", async () => {
    expect((await withdraw(outsider.accessToken, groupA)).status).toBe(404);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign({}, "x".repeat(40), { subject: president.userId, expiresIn: 60 });
    expect((await get(forged, groupA)).status).toBe(401);
  });

  it("rejects a token for a deactivated user immediately", async () => {
    const victim = await login(await registerVerified());
    await prisma.user.update({ where: { id: victim.userId }, data: { isActive: false } });
    expect((await get(victim.accessToken, groupA)).status).toBe(401);
  });

  it("a user who LEFT the group loses access", async () => {
    const leaver = await login(await registerVerified());
    const m = await prisma.groupMember.create({ data: { groupId: groupA, userId: leaver.userId } });
    expect((await get(leaver.accessToken, groupA)).status).toBe(200);
    await prisma.groupMember.update({ where: { id: m.id }, data: { status: "LEFT", leftAt: new Date() } });
    expect((await get(leaver.accessToken, groupA)).status).toBe(404);
  });
});
