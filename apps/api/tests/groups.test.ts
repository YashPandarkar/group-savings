import { describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { app, lastTokenFor } from "./helpers";
import {
  accept, addMember, addUsers, bearer, createGroup, invite, makeUser, memberIdOf,
} from "./groupHelpers";

describe("creating a group", () => {
  it("makes the creator President, sets up ledger accounts and encrypts the bank account", async () => {
    const u = await makeUser("Yash");
    const res = await createGroup(u, {
      description: "Our circle",
      bankAccountNumber: "123456789012",
      bankIfsc: "hdfc0001234",
    });
    expect(res.status).toBe(201);
    expect(res.body.group.yourRole).toBe("PRESIDENT");
    expect(res.body.group.monthlyContributionPaise).toBe(20000); // default ₹200
    expect(res.body.group.payment.ifsc).toBe("HDFC0001234");

    const groupId = res.body.group.id as string;
    const accounts = await prisma.ledgerAccount.findMany({ where: { groupId } });
    expect(accounts.map((a) => a.code).sort()).toEqual([
      "BANK_CLEARING", "GROUP_EQUITY", "INTEREST_INCOME", "LOANS_RECEIVABLE", "MEMBER_SAVINGS",
    ]);

    const stored = await prisma.group.findUniqueOrThrow({ where: { id: groupId } });
    expect(stored.bankAccountNumberEnc).toMatch(/^v1:/);
    expect(stored.bankAccountNumberEnc).not.toContain("123456789012");
    expect(await prisma.auditLog.count({ where: { groupId, action: "GROUP_CREATED" } })).toBe(1);
  });

  it("requires login", async () => {
    expect((await request(app).post("/api/groups").send({ name: "No Auth Group" })).status).toBe(401);
  });

  it("ONE GROUP PER USER: a second group is refused", async () => {
    const u = await makeUser();
    expect((await createGroup(u)).status).toBe(201);
    const second = await createGroup(u, { name: "Another Group" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("ALREADY_IN_GROUP");
  });

  it("two simultaneous creations: exactly one wins", async () => {
    const u = await makeUser();
    const [a, b] = await Promise.all([createGroup(u, { name: "Group One" }), createGroup(u, { name: "Group Two" })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await prisma.groupMember.count({ where: { userId: u.id, status: "ACTIVE" } })).toBe(1);
  });

  it("validates input", async () => {
    const u = await makeUser();
    expect((await createGroup(u, { maxMembers: 25 })).status).toBe(400);
    expect((await createGroup(u, { maxMembers: 5 })).status).toBe(400);
    expect((await createGroup(u, { interestMethod: "FLAT", interestRateBps: 0 })).status).toBe(400);
    expect((await createGroup(u, { interestMethod: "NONE", interestRateBps: 1200 })).status).toBe(400);
    expect((await createGroup(u, { monthlyContributionPaise: 20.5 })).status).toBe(400);
    expect((await createGroup(u, { name: "x" })).status).toBe(400);
  });

  it("GET /groups/me returns the group, or null when you have none", async () => {
    const u = await makeUser();
    expect((await request(app).get("/api/groups/me").set(bearer(u.token))).body.group).toBeNull();
    await createGroup(u);
    const res = await request(app).get("/api/groups/me").set(bearer(u.token));
    expect(res.body.group.yourRole).toBe("PRESIDENT");
  });
});

describe("tenant isolation", () => {
  it("another group's President cannot see or change this group", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const groupA = (await createGroup(a)).body.group.id as string;
    await createGroup(b, { name: "Other Circle" });

    const attempts = [
      request(app).get(`/api/groups/${groupA}`).set(bearer(b.token)),
      request(app).get(`/api/groups/${groupA}/members`).set(bearer(b.token)),
      request(app).get(`/api/groups/${groupA}/invitations`).set(bearer(b.token)),
      request(app).put(`/api/groups/${groupA}`).set(bearer(b.token)).send({ name: "Hijacked" }),
      invite(b, groupA, "someone@test.local"),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: groupA } })).name).toBe("Mitra Savings Circle");
  });

  it("a President cannot touch a member ID that belongs to another group", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const groupA = (await createGroup(a)).body.group.id as string;
    const groupB = (await createGroup(b, { name: "Other Circle" })).body.group.id as string;
    const [victim] = await addUsers(groupA, 1);
    const victimMemberId = await memberIdOf(groupA, victim.id);

    // b passes THEIR OWN group in the URL but A's member id: must not work.
    const res = await request(app)
      .put(`/api/groups/${groupB}/members/${victimMemberId}/role`)
      .set(bearer(b.token))
      .send({ role: "VICE_PRESIDENT" });
    expect(res.status).toBe(404);
  });
});

describe("invitations", () => {
  it("full flow: invite, accept, join as MEMBER; the link works once", async () => {
    const president = await makeUser("President");
    const invitee = await makeUser("Invitee");
    const groupId = (await createGroup(president)).body.group.id as string;

    const inv = await invite(president, groupId, invitee.email);
    expect(inv.status).toBe(201);
    expect(JSON.stringify(inv.body)).not.toContain("tokenHash");

    const token = lastTokenFor(invitee.email)!;
    const preview = await request(app).post("/api/invitations/preview").send({ token });
    expect(preview.status).toBe(200);
    expect(preview.body.groupName).toBe("Mitra Savings Circle");

    const ok = await accept(invitee, token);
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe("MEMBER");

    // Ordinary members see the list, but not each other's emails.
    const list = await request(app).get(`/api/groups/${groupId}/members`).set(bearer(invitee.token));
    expect(list.body.members).toHaveLength(2);
    expect(list.body.members.every((m: { email?: string }) => m.email === undefined)).toBe(true);
    // The President does see emails.
    const adminList = await request(app).get(`/api/groups/${groupId}/members`).set(bearer(president.token));
    expect(adminList.body.members.every((m: { email?: string }) => typeof m.email === "string")).toBe(true);

    expect((await accept(invitee, token)).status).toBe(400);
  });

  it("another account cannot use the invitation", async () => {
    const president = await makeUser();
    const invitee = await makeUser();
    const stranger = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    await invite(president, groupId, invitee.email);
    const token = lastTokenFor(invitee.email)!;

    const res = await accept(stranger, token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("WRONG_ACCOUNT");
    expect(await prisma.groupMember.count({ where: { userId: stranger.id } })).toBe(0);
  });

  it("someone already in a group can't accept, and the President isn't told they're in one", async () => {
    const president = await makeUser();
    const busy = await makeUser();
    await createGroup(busy, { name: "Busy's Own Group" });
    const groupId = (await createGroup(president)).body.group.id as string;

    const inv = await invite(president, groupId, busy.email);
    expect(inv.status).toBe(201); // no hint about the other group

    const res = await accept(busy, lastTokenFor(busy.email)!);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_IN_GROUP");
  });

  it("accepting one invitation cancels the others", async () => {
    const p1 = await makeUser();
    const p2 = await makeUser();
    const invitee = await makeUser();
    const g1 = (await createGroup(p1, { name: "Circle One" })).body.group.id as string;
    const g2 = (await createGroup(p2, { name: "Circle Two" })).body.group.id as string;

    await invite(p1, g1, invitee.email);
    const token1 = lastTokenFor(invitee.email)!;
    await invite(p2, g2, invitee.email);
    const token2 = lastTokenFor(invitee.email)!;

    expect((await accept(invitee, token1)).status).toBe(200);
    expect((await accept(invitee, token2)).status).toBe(400);
    const other = await prisma.invitation.findFirstOrThrow({ where: { groupId: g2, email: invitee.email } });
    expect(other.status).toBe("CANCELLED");
  });

  it("re-inviting replaces the old link", async () => {
    const president = await makeUser();
    const invitee = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    await invite(president, groupId, invitee.email);
    const oldToken = lastTokenFor(invitee.email)!;
    await invite(president, groupId, invitee.email);
    const newToken = lastTokenFor(invitee.email)!;

    expect((await accept(invitee, oldToken)).status).toBe(400);
    expect((await accept(invitee, newToken)).status).toBe(200);
  });

  it("expired invitations are rejected", async () => {
    const president = await makeUser();
    const invitee = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    await invite(president, groupId, invitee.email);
    await prisma.invitation.updateMany({ where: { groupId, email: invitee.email }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await accept(invitee, lastTokenFor(invitee.email)!)).status).toBe(400);
  });

  it("the President can cancel a pending invitation", async () => {
    const president = await makeUser();
    const invitee = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const inv = await invite(president, groupId, invitee.email);
    const del = await request(app)
      .delete(`/api/groups/${groupId}/invitations/${inv.body.invitation.id}`)
      .set(bearer(president.token));
    expect(del.status).toBe(204);
    expect((await accept(invitee, lastTokenFor(invitee.email)!)).status).toBe(400);
  });

  it("ordinary members cannot invite or list invitations", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const [member] = await addUsers(groupId, 1);
    expect((await invite(member, groupId, "x@test.local")).status).toBe(403);
    expect((await request(app).get(`/api/groups/${groupId}/invitations`).set(bearer(member.token))).status).toBe(403);
  });

  it("respects the group's capacity", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president, { maxMembers: 10 })).body.group.id as string;
    await addUsers(groupId, 9); // 10 members including the President: full

    const res = await invite(president, groupId, "late@test.local");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("GROUP_FULL");
  });

  it("the last seat can't be taken twice (invite sent while a seat was free)", async () => {
    const president = await makeUser();
    const invitee = await makeUser();
    const groupId = (await createGroup(president, { maxMembers: 10 })).body.group.id as string;
    await addUsers(groupId, 8); // 9 of 10
    expect((await invite(president, groupId, invitee.email)).status).toBe(201);
    await addUsers(groupId, 1); // someone else takes the seat: now 10 of 10

    const res = await accept(invitee, lastTokenFor(invitee.email)!);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("GROUP_FULL");
  });
});

describe("roles", () => {
  it("members cannot change roles, even by calling the API directly", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const [m1, m2] = await addUsers(groupId, 2);
    const res = await request(app)
      .put(`/api/groups/${groupId}/members/${await memberIdOf(groupId, m2.id)}/role`)
      .set(bearer(m1.token))
      .send({ role: "PRESIDENT" });
    expect(res.status).toBe(403);
  });

  it("appoints a VP; a new VP replaces the old one", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const [m1, m2] = await addUsers(groupId, 2);
    const setRole = async (userId: string, role: string) =>
      request(app)
        .put(`/api/groups/${groupId}/members/${await memberIdOf(groupId, userId)}/role`)
        .set(bearer(president.token))
        .send({ role });

    expect((await setRole(m1.id, "VICE_PRESIDENT")).status).toBe(200);
    expect((await setRole(m2.id, "VICE_PRESIDENT")).status).toBe(200);

    const roles = await prisma.groupMember.findMany({ where: { groupId, status: "ACTIVE", userId: { in: [m1.id, m2.id] } } });
    expect(roles.find((r) => r.userId === m1.id)!.role).toBe("MEMBER");
    expect(roles.find((r) => r.userId === m2.id)!.role).toBe("VICE_PRESIDENT");
    expect(await prisma.groupMember.count({ where: { groupId, status: "ACTIVE", role: "VICE_PRESIDENT" } })).toBe(1);

    // The VP gets VP powers (can see emails) but not President powers.
    expect((await request(app).get(`/api/groups/${groupId}/members`).set(bearer(m2.token))).body.members[0].email).toBeTypeOf("string");
    expect((await invite(m2, groupId, "nope@test.local")).status).toBe(403);
  });

  it("transfers the presidency: old President becomes a member, there is only ever one President", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const [vp] = await addUsers(groupId, 1);
    const vpMemberId = await memberIdOf(groupId, vp.id);
    const setRole = (role: string) =>
      request(app).put(`/api/groups/${groupId}/members/${vpMemberId}/role`).set(bearer(president.token)).send({ role });

    await setRole("VICE_PRESIDENT");
    const res = await setRole("PRESIDENT");
    expect(res.status).toBe(200);
    expect(res.body.yourNewRole).toBe("MEMBER");

    expect(await prisma.groupMember.count({ where: { groupId, status: "ACTIVE", role: "PRESIDENT" } })).toBe(1);
    expect((await prisma.groupMember.findFirstOrThrow({ where: { groupId, userId: vp.id, status: "ACTIVE" } })).role).toBe("PRESIDENT");
    expect((await invite(president, groupId, "x@test.local")).status).toBe(403); // old President lost powers
    expect((await invite(vp, groupId, "y@test.local")).status).toBe(201);
  });

  it("you cannot change your own role", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const res = await request(app)
      .put(`/api/groups/${groupId}/members/${await memberIdOf(groupId, president.id)}/role`)
      .set(bearer(president.token))
      .send({ role: "MEMBER" });
    expect(res.status).toBe(400);
  });

  it("rejects unknown roles", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const [m] = await addUsers(groupId, 1);
    const res = await request(app)
      .put(`/api/groups/${groupId}/members/${await memberIdOf(groupId, m.id)}/role`)
      .set(bearer(president.token))
      .send({ role: "SUPERADMIN" });
    expect(res.status).toBe(400);
  });
});

describe("leaving and removal", () => {
  it("a member can leave and then join another group; history is kept", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const [member] = await addUsers(groupId, 1);

    const res = await request(app).post(`/api/groups/${groupId}/leave`).set(bearer(member.token));
    expect(res.status).toBe(200);

    const row = await prisma.groupMember.findFirstOrThrow({ where: { groupId, userId: member.id } });
    expect(row.status).toBe("LEFT");
    expect(row.leftAt).not.toBeNull();
    expect((await request(app).get(`/api/groups/${groupId}`).set(bearer(member.token))).status).toBe(404);
    expect((await createGroup(member, { name: "My New Circle" })).status).toBe(201);
  });

  it("the President can't leave without transferring first", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const res = await request(app).post(`/api/groups/${groupId}/leave`).set(bearer(president.token));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PRESIDENT_CANNOT_LEAVE");
  });

  it("a member with an open loan can't leave", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const [member] = await addUsers(groupId, 1);
    await prisma.loan.create({
      data: {
        groupId, userId: member.id, principalPaise: 100000n, purpose: "Test",
        installmentCount: 6, interestMethod: "NONE", interestRateBps: 0, status: "ACTIVE",
      },
    });
    const res = await request(app).post(`/api/groups/${groupId}/leave`).set(bearer(member.token));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("HAS_OPEN_LOAN");
  });

  it("a member whose savings are still in the fund can't leave or be removed", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const [member] = await addUsers(groupId, 1);

    const accounts = await prisma.ledgerAccount.findMany({ where: { groupId } });
    const bank = accounts.find((a) => a.code === "BANK_CLEARING")!;
    const savings = accounts.find((a) => a.code === "MEMBER_SAVINGS" && a.userId === member.id)!;
    await prisma.$transaction(async (tx) => {
      const journal = await tx.ledgerJournal.create({
        data: { groupId, type: "MONTHLY_DEPOSIT", description: "test deposit", createdById: president.id },
      });
      await tx.ledgerEntry.createMany({
        data: [
          { journalId: journal.id, groupId, accountId: bank.id, direction: "DEBIT", amountPaise: 20000n },
          { journalId: journal.id, groupId, accountId: savings.id, direction: "CREDIT", amountPaise: 20000n },
        ],
      });
    });

    const leave = await request(app).post(`/api/groups/${groupId}/leave`).set(bearer(member.token));
    expect(leave.status).toBe(409);
    expect(leave.body.error.code).toBe("SAVINGS_NOT_PAID_OUT");
    expect(leave.body.error.message).toContain("₹200.00");

    const remove = await request(app)
      .post(`/api/groups/${groupId}/members/${await memberIdOf(groupId, member.id)}/remove`)
      .set(bearer(president.token));
    expect(remove.status).toBe(409);
  });

  it("the President can remove a member; a member cannot remove anyone", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const [m1, m2] = await addUsers(groupId, 2);
    const m2Id = await memberIdOf(groupId, m2.id);

    expect((await request(app).post(`/api/groups/${groupId}/members/${m2Id}/remove`).set(bearer(m1.token))).status).toBe(403);

    const res = await request(app).post(`/api/groups/${groupId}/members/${m2Id}/remove`).set(bearer(president.token));
    expect(res.status).toBe(200);
    expect((await prisma.groupMember.findUniqueOrThrow({ where: { id: m2Id } })).status).toBe("REMOVED");
    expect((await request(app).get(`/api/groups/${groupId}`).set(bearer(m2.token))).status).toBe(404);
  });
});

describe("group settings and member details", () => {
  it("only the President can update settings; empty updates are refused", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const [member] = await addUsers(groupId, 1);

    const denied = await request(app).put(`/api/groups/${groupId}`).set(bearer(member.token)).send({ monthlyContributionPaise: 50000 });
    expect(denied.status).toBe(403);

    const empty = await request(app).put(`/api/groups/${groupId}`).set(bearer(president.token)).send({});
    expect(empty.status).toBe(400);

    const ok = await request(app)
      .put(`/api/groups/${groupId}`)
      .set(bearer(president.token))
      .send({ monthlyContributionPaise: 50000, interestMethod: "FLAT", interestRateBps: 1200, bankAccountNumber: "998877665544" });
    expect(ok.status).toBe(200);
    expect(ok.body.group.monthlyContributionPaise).toBe(50000);
    expect(ok.body.group.interestRateBps).toBe(1200);

    // Members read the payment details; the database holds ciphertext.
    const asMember = await request(app).get(`/api/groups/${groupId}`).set(bearer(member.token));
    expect(asMember.body.group.payment.accountNumber).toBe("998877665544");
    const stored = await prisma.group.findUniqueOrThrow({ where: { id: groupId } });
    expect(stored.bankAccountNumberEnc).not.toContain("998877665544");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { groupId, action: "GROUP_SETTINGS_UPDATED" } });
    expect(JSON.stringify(audit)).not.toContain("998877665544");
  });

  it("an interest policy must be consistent after an update", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const res = await request(app).put(`/api/groups/${groupId}`).set(bearer(president.token)).send({ interestMethod: "REDUCING_BALANCE" });
    expect(res.status).toBe(400); // rate is still 0
  });

  it("can't set the member limit below the current member count", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president, { maxMembers: 15 })).body.group.id as string;
    await addUsers(groupId, 11); // 12 members
    const res = await request(app).put(`/api/groups/${groupId}`).set(bearer(president.token)).send({ maxMembers: 10 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CAPACITY_BELOW_MEMBERS");
  });

  it("members can open their own record but not other members'", async () => {
    const president = await makeUser();
    const groupId = (await createGroup(president)).body.group.id as string;
    const [m1, m2] = await addUsers(groupId, 2);
    const m1Id = await memberIdOf(groupId, m1.id);
    const m2Id = await memberIdOf(groupId, m2.id);

    expect((await request(app).get(`/api/groups/${groupId}/members/${m1Id}`).set(bearer(m1.token))).status).toBe(200);
    expect((await request(app).get(`/api/groups/${groupId}/members/${m2Id}`).set(bearer(m1.token))).status).toBe(404);
    expect((await request(app).get(`/api/groups/${groupId}/members/${m2Id}`).set(bearer(president.token))).status).toBe(200);
  });
});
