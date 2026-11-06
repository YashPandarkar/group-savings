import request from "supertest";
import type { GroupRole } from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { signAccessToken } from "../src/lib/jwt";
import { ensureMemberAccounts } from "../src/lib/ledgerAccounts";
import { app, uniqueEmail } from "./helpers";

export type TestUser = { id: string; email: string; token: string };

// Creates a verified user directly in the DB (fast) with a valid access token.
export async function makeUser(name = "Test User"): Promise<TestUser> {
  const user = await prisma.user.create({
    data: { email: uniqueEmail(), name, passwordHash: "not-used-in-these-tests", emailVerifiedAt: new Date() },
  });
  return { id: user.id, email: user.email, token: signAccessToken(user.id) };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export const createGroup = (user: TestUser, overrides: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/groups")
    .set(bearer(user.token))
    .send({ name: "Mitra Savings Circle", ...overrides });

// Adds an ACTIVE member directly (bypassing invitations) to set up scenarios fast.
export async function addMember(groupId: string, userId: string, role: GroupRole = "MEMBER") {
  await prisma.$transaction(async (tx) => {
    await tx.groupMember.create({ data: { groupId, userId, role } });
    await ensureMemberAccounts(tx, groupId, userId);
  });
}

export async function addUsers(groupId: string, count: number): Promise<TestUser[]> {
  const users: TestUser[] = [];
  for (let i = 0; i < count; i++) {
    const u = await makeUser(`Member ${i + 1}`);
    await addMember(groupId, u.id);
    users.push(u);
  }
  return users;
}

export const memberIdOf = async (groupId: string, userId: string) =>
  (await prisma.groupMember.findFirstOrThrow({ where: { groupId, userId, status: "ACTIVE" } })).id;

export const invite = (president: TestUser, groupId: string, email: string) =>
  request(app).post(`/api/groups/${groupId}/invitations`).set(bearer(president.token)).send({ email });

export const accept = (user: TestUser, token: string) =>
  request(app).post("/api/invitations/accept").set(bearer(user.token)).send({ token });
