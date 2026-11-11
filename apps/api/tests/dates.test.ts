import { describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { installmentDueDate } from "../src/lib/loanDates";
import { deriveInstallmentStatus, isDue } from "../src/lib/loanRules";
import { dueDateFor, periodOf } from "../src/lib/period";
import { ensureContributions } from "../src/modules/contributions/contributions.service";
import { app } from "./helpers";
import { addUsers, bearer, createGroup, makeUser } from "./groupHelpers";

const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
let seq = 0;

describe("India-time boundaries (pure)", () => {
  it("the contribution month flips exactly at midnight IST, including across a year", () => {
    expect(periodOf(new Date("2026-04-30T18:29:59.999Z"))).toEqual({ year: 2026, month: 4 });
    expect(periodOf(new Date("2026-04-30T18:30:00.000Z"))).toEqual({ year: 2026, month: 5 });
    expect(periodOf(new Date("2026-12-31T18:30:00.000Z"))).toEqual({ year: 2027, month: 1 });
  });

  it("a due date is the last millisecond of that day in India", () => {
    expect(dueDateFor(2026, 11, 10).toISOString()).toBe("2026-11-10T18:29:59.999Z");
  });

  it("an installment 'is due' from 00:00 IST on its due day, not a moment before", () => {
    const due = dueDateFor(2026, 11, 10);
    expect(isDue({ dueDate: due }, new Date("2026-11-09T18:30:00.000Z"))).toBe(true);
    expect(isDue({ dueDate: due }, new Date("2026-11-09T18:29:59.000Z"))).toBe(false);
  });

  it("an installment becomes overdue only after the due moment has passed", () => {
    const due = dueDateFor(2026, 11, 10);
    const base = { dueDate: due, totalDuePaise: 100n };
    expect(deriveInstallmentStatus({ ...base, paidPaise: 0n }, new Date(due.getTime()))).toBe("PENDING");
    expect(deriveInstallmentStatus({ ...base, paidPaise: 0n }, new Date(due.getTime() + 1))).toBe("OVERDUE");
    expect(deriveInstallmentStatus({ ...base, paidPaise: 100n }, new Date(due.getTime() + 1))).toBe("PAID");
  });

  it("a loan sent at 01:30 IST on 1 Feb is due on 1 Mar (UTC would still say 31 Jan)", () => {
    const sent = new Date("2026-01-31T20:00:00.000Z");
    expect(istDate(installmentDueDate(sent, 1, "MONTHLY"))).toBe("2026-03-01");
    expect(istDate(installmentDueDate(sent, 2, "MONTHLY"))).toBe("2026-04-01");
  });

  it("29 Feb clamps to 28 Feb in a non-leap year", () => {
    const sent = new Date("2028-02-29T10:00:00+05:30");
    expect(istDate(installmentDueDate(sent, 12, "MONTHLY"))).toBe("2029-02-28");
  });
});

describe("India-time boundaries (database)", () => {
  it("transaction date filters use India days, not UTC days", async () => {
    const president = await makeUser("President");
    const groupId = (await createGroup(president)).body.group.id as string;
    const [m1] = await addUsers(groupId, 1);

    const day = istDate(new Date(Date.now() - 30 * 86_400_000));
    const startOfDay = new Date(`${day}T00:00:00+05:30`).getTime();
    const nextDay = istDate(new Date(startOfDay + 36 * 3_600_000));
    const lastSecond = `${day}T23:59:59+05:30`;
    const firstSecondNext = `${nextDay}T00:00:00+05:30`; // one second later: a different India day

    const record = (paidAt: string) =>
      request(app)
        .post(`/api/groups/${groupId}/deposits/manual`)
        .set(bearer(president.token))
        .send({
          userId: m1.id, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 10000, method: "CASH",
          evidenceNote: "Cash received at the meeting", clientRequestId: `dt-${Date.now()}-${++seq}`, paidAt,
        })
        .expect(201);
    await record(lastSecond);
    await record(firstSecondNext);

    const list = (qs: string) => request(app).get(`/api/groups/${groupId}/transactions?${qs}`).set(bearer(president.token));
    const first = await list(`from=${day}&to=${day}`);
    expect(first.body.total).toBe(1);
    expect(new Date(first.body.items[0].occurredAt).getTime()).toBe(new Date(lastSecond).getTime());
    expect((await list(`from=${nextDay}&to=${nextDay}`)).body.total).toBe(1);
    expect((await list(`from=${day}&to=${nextDay}`)).body.total).toBe(2);
  });

  it("a member who joined exactly at the due moment owes the month; one millisecond later does not", async () => {
    const president = await makeUser("President");
    const groupId = (await createGroup(president)).body.group.id as string;
    const [on, after] = await addUsers(groupId, 2);
    await prisma.groupMember.updateMany({ where: { groupId }, data: { joinedAt: new Date(Date.now() - 62 * 86_400_000) } });

    const { year, month } = periodOf(new Date());
    const due = dueDateFor(year, month, 10);
    await prisma.groupMember.updateMany({ where: { groupId, userId: on.id }, data: { joinedAt: due } });
    await prisma.groupMember.updateMany({ where: { groupId, userId: after.id }, data: { joinedAt: new Date(due.getTime() + 1) } });

    await ensureContributions(prisma, groupId, year, month);
    expect(await prisma.contribution.count({ where: { groupId, userId: on.id } })).toBe(1);
    expect(await prisma.contribution.count({ where: { groupId, userId: after.id } })).toBe(0);
  });
});
