import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { ensureMemberAccounts } from "../lib/ledgerAccounts";
import { hashPassword } from "../lib/password";
import { recordManualDeposit } from "../modules/contributions/deposits.service";
import { createGroupSchema } from "../modules/groups/groups.schema";
import { createGroup } from "../modules/groups/groups.service";

// Demo data for LOCAL use: a group, a President, a Vice President, three members, and some savings.
// Refuses to run in production, and does nothing if the demo data already exists.
const PASSWORD = "DemoPassw0rd!";
const PEOPLE = [
  { name: "Demo President", email: "president@demo.local" },
  { name: "Demo Vice President", email: "vp@demo.local" },
  { name: "Demo Member One", email: "member1@demo.local" },
  { name: "Demo Member Two", email: "member2@demo.local" },
  { name: "Demo Member Three", email: "member3@demo.local" },
];

async function main() {
  if (env.NODE_ENV === "production") {
    console.error("Refusing to create demo data when NODE_ENV=production.");
    process.exit(1);
  }
  if (await prisma.user.findUnique({ where: { email: PEOPLE[0].email } })) {
    console.log("Demo data already exists. Nothing to do.");
    return;
  }

  const passwordHash = await hashPassword(PASSWORD);
  const users = [];
  for (const p of PEOPLE) {
    users.push(await prisma.user.create({ data: { name: p.name, email: p.email, passwordHash, emailVerifiedAt: new Date() } }));
  }
  const [president, vp, ...members] = users;

  const group = await createGroup(
    { id: president.id, email: president.email },
    createGroupSchema.parse({ name: "Demo Savings Circle" }),
    {}
  );

  await prisma.$transaction(async (tx) => {
    for (const u of [vp, ...members]) {
      await tx.groupMember.create({ data: { groupId: group.id, userId: u.id, role: u.id === vp.id ? "VICE_PRESIDENT" : "MEMBER" } });
      await ensureMemberAccounts(tx, group.id, u.id);
    }
  });

  // Nobody records their own deposit: the President records for everyone else, the VP records the President's.
  for (const u of [vp, ...members]) {
    await recordManualDeposit(
      group.id,
      { id: president.id, name: president.name },
      { userId: u.id, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 100000, method: "CASH", evidenceNote: "Demo data", clientRequestId: `seed-${u.id}` },
      {}
    );
  }
  await recordManualDeposit(
    group.id,
    { id: vp.id, name: vp.name },
    { userId: president.id, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 100000, method: "CASH", evidenceNote: "Demo data", clientRequestId: `seed-${president.id}` },
    {}
  );

  console.log(`✅ Demo group "${group.name}" created.`);
  console.log(`   Log in as ${PEOPLE.map((p) => p.email).join(", ")}`);
  console.log(`   Password for all of them: ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
