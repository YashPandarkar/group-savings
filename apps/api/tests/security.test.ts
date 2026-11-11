import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { openApiDocument } from "../src/docs/openapi";
import { app } from "./helpers";
import { addMember, addUsers, bearer, createGroup, makeUser, type TestUser } from "./groupHelpers";

/* eslint-disable @typescript-eslint/no-explicit-any */
const UUID = "00000000-0000-4000-8000-000000000000";

type Op = { method: string; path: string; bearerAuth: boolean; who: "ADMIN" | "PRESIDENT" | null; grouped: boolean };

// The matrix is generated from the SAME list that documents the API, so a new endpoint is covered automatically.
const doc = openApiDocument as Record<string, any>;
const ops: Op[] = Object.entries(doc.paths as Record<string, any>).flatMap(([p, item]) =>
  Object.entries(item as Record<string, any>).map(([method, op]) => {
    const desc = String(op.description ?? "");
    return {
      method,
      path: p,
      bearerAuth: JSON.stringify(op.security) === JSON.stringify([{ bearerAuth: [] }]),
      who: desc.includes("**Who can do this:** President and Vice President.")
        ? "ADMIN"
        : desc.includes("**Who can do this:** President.")
          ? "PRESIDENT"
          : null,
      grouped: p.includes("{groupId}"),
    } as Op;
  })
);

function fire(o: Op, token: string | null, groupId: string) {
  const url = o.path.replace("{groupId}", groupId).replace(/\{\w+\}/g, UUID);
  let r = (request(app) as any)[o.method](url);
  if (token) r = r.set(bearer(token));
  if (o.method !== "get" && o.method !== "delete") r = r.set("Content-Type", "application/json").send("{}");
  return r as Promise<{ status: number }>;
}

// Runs every selected operation and returns the ones that answered unexpectedly.
async function mismatches(selected: Op[], token: string | null, groupId: string, ok: (status: number) => boolean) {
  const bad: string[] = [];
  for (const o of selected) {
    const { status } = await fire(o, token, groupId);
    if (!ok(status)) bad.push(`${o.method.toUpperCase()} ${o.path} -> ${status}`);
  }
  return bad;
}

let groupId = "";
let vp: TestUser;
let member: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  const president = await makeUser("President");
  groupId = (await createGroup(president)).body.group.id as string;
  vp = await makeUser("Vice President");
  await addMember(groupId, vp.id, "VICE_PRESIDENT");
  [member] = await addUsers(groupId, 1);
  outsider = await makeUser("Outsider");
  await createGroup(outsider, { name: "Other Circle" });
});

describe("the permission matrix (every documented endpoint)", () => {
  it("parsed enough of the API to mean something", () => {
    expect(ops.filter((o) => o.bearerAuth).length).toBeGreaterThan(50);
    expect(ops.filter((o) => o.who === "ADMIN").length).toBeGreaterThan(8);
    expect(ops.filter((o) => o.who === "PRESIDENT").length).toBeGreaterThan(5);
    expect(ops.filter((o) => o.grouped).length).toBeGreaterThanOrEqual(25);
  });

  it("without a login (or with a garbage token) every protected endpoint says 401", async () => {
    const protectedOps = ops.filter((o) => o.bearerAuth);
    expect(await mismatches(protectedOps, null, groupId, (s) => s === 401)).toEqual([]);
    expect(await mismatches(protectedOps, "not-a-real-token", groupId, (s) => s === 401)).toEqual([]);
  });

  it("an ordinary member gets 403 on every administrator-only endpoint", async () => {
    const restricted = ops.filter((o) => o.who && o.grouped);
    expect(await mismatches(restricted, member.token, groupId, (s) => s === 403)).toEqual([]);
  });

  it("the Vice President gets 403 on President-only endpoints, and is let past the permission check on the rest", async () => {
    const presidentOnly = ops.filter((o) => o.who === "PRESIDENT" && o.grouped);
    expect(await mismatches(presidentOnly, vp.token, groupId, (s) => s === 403)).toEqual([]);

    const shared = ops.filter((o) => o.who === "ADMIN" && o.grouped);
    // Past the permission check means: not 401/403, and no server error (400/404/409 are fine for dummy input).
    expect(await mismatches(shared, vp.token, groupId, (s) => s !== 401 && s !== 403 && s < 500)).toEqual([]);
  });

  it("TENANT ISOLATION: another group's President gets 404 on every group-scoped endpoint", async () => {
    const scoped = ops.filter((o) => o.bearerAuth && o.grouped);
    expect(await mismatches(scoped, outsider.token, groupId, (s) => s === 404)).toEqual([]);
  });
});

describe("a deposit can't be reversed out from under reserved money", () => {
  it("approved withdrawals block the reversal until they are cancelled", async () => {
    const president = await makeUser("President");
    const gid = (await createGroup(president)).body.group.id as string;
    const [m1] = await addUsers(gid, 1);
    const dep = await request(app)
      .post(`/api/groups/${gid}/deposits/manual`)
      .set(bearer(president.token))
      .send({
        userId: m1.id, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 20000, method: "CASH",
        evidenceNote: "Cash received at the meeting", clientRequestId: `sec-${Date.now()}`,
      });
    expect(dep.status).toBe(201);
    const journalId = (await prisma.ledgerJournal.findFirstOrThrow({ where: { groupId: gid } })).id;

    const wd = await request(app)
      .post(`/api/groups/${gid}/withdrawals`)
      .set(bearer(president.token))
      .send({ kind: "MEMBER_PAYOUT", beneficiaryUserId: m1.id, amountPaise: 20000, purpose: "Payout of savings" });
    expect(wd.status).toBe(201); // approved: the money is reserved

    const reverse = () =>
      request(app)
        .post(`/api/groups/${gid}/transactions/${journalId}/reverse`)
        .set(bearer(president.token))
        .send({ reason: "Recorded against the wrong member" });

    const blocked = await reverse();
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("INSUFFICIENT_FUND");

    const cancel = await request(app).post(`/api/withdrawals/${wd.body.withdrawal.id}/cancel`).set(bearer(president.token)).send({});
    expect(cancel.status).toBe(200);
    expect((await reverse()).status).toBe(201);
  });
});

// ───────────── patterns that must never appear in the code ─────────────

function sourceFiles(dir: string, skip: RegExp): { file: string; code: string }[] {
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !skip.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      const code = fs
        .readFileSync(full, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)) // ignore comment lines
        .join("\n");
      return { file: full, code };
    });
}
const found = (files: { file: string; code: string }[], pattern: RegExp) =>
  files.filter((f) => pattern.test(f.code)).map((f) => path.relative(process.cwd(), f.file));

describe("source scans", () => {
  it("the API never builds SQL from strings or evaluates code", () => {
    const api = sourceFiles(path.resolve(process.cwd(), "src"), /^$/);
    expect(api.length).toBeGreaterThan(40);
    expect(found(api, /\$queryRawUnsafe|\$executeRawUnsafe|\beval\(|new Function\(/)).toEqual([]);
  });

  it("the web app has no raw HTML injection, no browser storage, and no payment secrets", () => {
    const web = sourceFiles(path.resolve(process.cwd(), "../web/src"), /\.test\.tsx?$|[\\/]test[\\/]/);
    expect(web.length).toBeGreaterThan(40);
    expect(found(web, /dangerouslySetInnerHTML|\.innerHTML\s*=|localStorage|sessionStorage|\beval\(/)).toEqual([]);
    expect(found(web, /KEY_SECRET|WEBHOOK_SECRET|key_secret/)).toEqual([]);
  });
});
