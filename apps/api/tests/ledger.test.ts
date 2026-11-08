import { describe, expect, it } from "vitest";
import { prisma } from "../src/config/prisma";
import { getAccountId, groupFundBalance, postJournal } from "../src/lib/ledger";
import { createGroup, makeUser } from "./groupHelpers";

async function setup() {
  const president = await makeUser();
  const groupId = (await createGroup(president)).body.group.id as string;
  const bank = await getAccountId(prisma, groupId, "BANK_CLEARING");
  const savings = await getAccountId(prisma, groupId, "MEMBER_SAVINGS", president.id);
  return { president, groupId, bank, savings };
}

describe("postJournal", () => {
  it("posts a balanced journal and the fund balance reflects it", async () => {
    const { president, groupId, bank, savings } = await setup();
    await prisma.$transaction((tx) =>
      postJournal(tx, {
        groupId, type: "MONTHLY_DEPOSIT", description: "test", createdById: president.id,
        lines: [
          { accountId: bank, direction: "DEBIT", amountPaise: 20000n },
          { accountId: savings, direction: "CREDIT", amountPaise: 20000n },
        ],
      })
    );
    expect(await groupFundBalance(prisma, groupId)).toBe(20000n);
  });

  it("refuses unbalanced, single-line and zero-amount journals, and writes nothing", async () => {
    const { president, groupId, bank, savings } = await setup();
    const base = { groupId, type: "ADJUSTMENT" as const, description: "bad", createdById: president.id };

    await expect(
      prisma.$transaction((tx) =>
        postJournal(tx, { ...base, lines: [
          { accountId: bank, direction: "DEBIT", amountPaise: 200n },
          { accountId: savings, direction: "CREDIT", amountPaise: 100n },
        ] })
      )
    ).rejects.toThrow(/unbalanced/i);

    await expect(
      prisma.$transaction((tx) => postJournal(tx, { ...base, lines: [{ accountId: bank, direction: "DEBIT", amountPaise: 100n }] }))
    ).rejects.toThrow(/at least two/i);

    await expect(
      prisma.$transaction((tx) =>
        postJournal(tx, { ...base, lines: [
          { accountId: bank, direction: "DEBIT", amountPaise: 0n },
          { accountId: savings, direction: "CREDIT", amountPaise: 0n },
        ] })
      )
    ).rejects.toThrow(/positive/i);

    expect(await prisma.ledgerJournal.count({ where: { groupId } })).toBe(0);
  });

  it("an idempotency key makes the second post a no-op", async () => {
    const { president, groupId, bank, savings } = await setup();
    const post = () =>
      prisma.$transaction((tx) =>
        postJournal(tx, {
          groupId, type: "MONTHLY_DEPOSIT", description: "once", createdById: president.id, idempotencyKey: "same-key",
          lines: [
            { accountId: bank, direction: "DEBIT", amountPaise: 5000n },
            { accountId: savings, direction: "CREDIT", amountPaise: 5000n },
          ],
        })
      );
    const a = await post();
    const b = await post();
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.journal.id).toBe(a.journal.id);
    expect(await prisma.ledgerEntry.count({ where: { groupId } })).toBe(2);
    expect(await groupFundBalance(prisma, groupId)).toBe(5000n);
  });
});
