import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";

type Tx = Prisma.TransactionClient;
class Rollback extends Error {}

// Runs fn in a transaction that is ALWAYS rolled back.
// Returns null if fn succeeded, or the database error message if it failed.
async function run(fn: (tx: Tx) => Promise<void>): Promise<string | null> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
    return null;
  } catch (e) {
    if (e instanceof Rollback) return null;
    return e instanceof Error ? e.message : String(e);
  }
}

let counter = 0;
const uid = () => `${Date.now()}-${++counter}`;
let failures = 0;

const short = (m: string) => m.trim().split("\n").filter(Boolean).pop()!.slice(0, 120);

function expectBlocked(name: string, err: string | null) {
  if (err) console.log(`✅ ${name}\n     blocked: ${short(err)}`);
  else { console.log(`❌ ${name}: should have been blocked`); failures++; }
}
function expectAllowed(name: string, err: string | null) {
  if (!err) console.log(`✅ ${name}`);
  else { console.log(`❌ ${name}: should have worked\n     ${short(err)}`); failures++; }
}

// ---- fixtures ----
const mkUser = (tx: Tx) =>
  tx.user.create({ data: { email: `u${uid()}@test.local`, name: "Test", passwordHash: "x" } });

const mkGroup = (tx: Tx, createdById: string) =>
  tx.group.create({
    data: { name: "Test Group", monthlyContributionPaise: 20000n, maxMembers: 10, createdById },
  });

async function mkLedger(tx: Tx) {
  const user = await mkUser(tx);
  const group = await mkGroup(tx, user.id);
  const bank = await tx.ledgerAccount.create({
    data: { groupId: group.id, code: "BANK_CLEARING", type: "ASSET", name: "Bank" },
  });
  const savings = await tx.ledgerAccount.create({
    data: { groupId: group.id, code: "MEMBER_SAVINGS", type: "LIABILITY", userId: user.id, name: "Savings" },
  });
  const journal = await tx.ledgerJournal.create({
    data: { groupId: group.id, type: "MONTHLY_DEPOSIT", description: "test", createdById: user.id },
  });
  return { user, group, bank, savings, journal };
}

// Check the balance rule right now instead of at COMMIT (we never commit in tests).
const checkBalanceNow = (tx: Tx) =>
  tx.$executeRaw`SET CONSTRAINTS ledger_entries_balanced IMMEDIATE`;

async function main() {
  // 1. One active group per user
  expectBlocked(
    "User cannot be ACTIVE in two groups",
    await run(async (tx) => {
      const u = await mkUser(tx);
      const g1 = await mkGroup(tx, u.id);
      const g2 = await mkGroup(tx, u.id);
      await tx.groupMember.create({ data: { groupId: g1.id, userId: u.id, role: "PRESIDENT" } });
      await tx.groupMember.create({ data: { groupId: g2.id, userId: u.id, role: "PRESIDENT" } });
    })
  );

  // 2. ...but can join another after leaving
  expectAllowed(
    "User can join another group after LEAVING the first",
    await run(async (tx) => {
      const u = await mkUser(tx);
      const g1 = await mkGroup(tx, u.id);
      const g2 = await mkGroup(tx, u.id);
      const m = await tx.groupMember.create({ data: { groupId: g1.id, userId: u.id } });
      await tx.groupMember.update({ where: { id: m.id }, data: { status: "LEFT", leftAt: new Date() } });
      await tx.groupMember.create({ data: { groupId: g2.id, userId: u.id } });
    })
  );

  // 3. Only one President
  expectBlocked(
    "A group cannot have two active Presidents",
    await run(async (tx) => {
      const a = await mkUser(tx);
      const b = await mkUser(tx);
      const g = await mkGroup(tx, a.id);
      await tx.groupMember.create({ data: { groupId: g.id, userId: a.id, role: "PRESIDENT" } });
      await tx.groupMember.create({ data: { groupId: g.id, userId: b.id, role: "PRESIDENT" } });
    })
  );

  // 4. Unbalanced journal
  expectBlocked(
    "Unbalanced journal (debit 200, credit 100) is rejected",
    await run(async (tx) => {
      const { group, bank, savings, journal } = await mkLedger(tx);
      await checkBalanceNow(tx);
      await tx.ledgerEntry.createMany({
        data: [
          { journalId: journal.id, groupId: group.id, accountId: bank.id, direction: "DEBIT", amountPaise: 20000n },
          { journalId: journal.id, groupId: group.id, accountId: savings.id, direction: "CREDIT", amountPaise: 10000n },
        ],
      });
    })
  );

  // 5. Balanced journal
  expectAllowed(
    "Balanced journal (debit 200, credit 200) is accepted",
    await run(async (tx) => {
      const { group, bank, savings, journal } = await mkLedger(tx);
      await checkBalanceNow(tx);
      await tx.ledgerEntry.createMany({
        data: [
          { journalId: journal.id, groupId: group.id, accountId: bank.id, direction: "DEBIT", amountPaise: 20000n },
          { journalId: journal.id, groupId: group.id, accountId: savings.id, direction: "CREDIT", amountPaise: 20000n },
        ],
      });
    })
  );

  // 6 & 7. Immutability
  const setupBalanced = async (tx: Tx) => {
    const { group, bank, savings, journal } = await mkLedger(tx);
    await checkBalanceNow(tx);
    await tx.ledgerEntry.createMany({
      data: [
        { journalId: journal.id, groupId: group.id, accountId: bank.id, direction: "DEBIT", amountPaise: 20000n },
        { journalId: journal.id, groupId: group.id, accountId: savings.id, direction: "CREDIT", amountPaise: 20000n },
      ],
    });
    return journal;
  };

  expectBlocked(
    "Editing a ledger entry is rejected",
    await run(async (tx) => {
      const journal = await setupBalanced(tx);
      const entry = await tx.ledgerEntry.findFirstOrThrow({ where: { journalId: journal.id } });
      await tx.ledgerEntry.update({ where: { id: entry.id }, data: { amountPaise: 1n } });
    })
  );

  expectBlocked(
    "Deleting ledger entries is rejected",
    await run(async (tx) => {
      const journal = await setupBalanced(tx);
      await tx.ledgerEntry.deleteMany({ where: { journalId: journal.id } });
    })
  );

  // 8. Value checks
  expectBlocked(
    "Zero-amount ledger entry is rejected",
    await run(async (tx) => {
      const { group, bank, journal } = await mkLedger(tx);
      await tx.ledgerEntry.create({
        data: { journalId: journal.id, groupId: group.id, accountId: bank.id, direction: "DEBIT", amountPaise: 0n },
      });
    })
  );

  console.log(failures === 0 ? "\n🎉 All database guards work." : `\n⚠️  ${failures} check(s) failed.`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main();
