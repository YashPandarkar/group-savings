import { prisma } from "../config/prisma";
import { syncGroupLoans } from "../modules/loans/loans.service";

async function main() {
  const groups = await prisma.group.findMany({ select: { id: true } });
  for (const g of groups) await syncGroupLoans(g.id);
  const overdue = await prisma.loan.count({ where: { status: "OVERDUE" } });
  console.log(`✅ Synced loans for ${groups.length} groups. Overdue loans: ${overdue}`);
  await prisma.$disconnect();
}
main();
