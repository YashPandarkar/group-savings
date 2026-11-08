import { prisma } from "../config/prisma";
import { periodOf } from "../lib/period";
import { ensureContributions } from "../modules/contributions/contributions.service";

async function main() {
  const { year, month } = periodOf(new Date());
  const groups = await prisma.group.findMany({ select: { id: true } });
  let created = 0;
  for (const g of groups) created += await ensureContributions(prisma, g.id, year, month);
  console.log(`✅ ${year}-${String(month).padStart(2, "0")}: created ${created} contribution rows across ${groups.length} groups`);
  await prisma.$disconnect();
}
main();
