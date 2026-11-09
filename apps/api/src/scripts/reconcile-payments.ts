import { prisma } from "../config/prisma";
import { reconcilePayments } from "../modules/payments/payments.reconcile";

async function main() {
  const s = await reconcilePayments();
  console.log(`✅ Reconciled ${s.checked} open orders: ${s.applied} applied, ${s.updated} updated, ${s.abandoned} abandoned, ${s.errors} errors`);
  await prisma.$disconnect();
  process.exit(s.errors === 0 ? 0 : 1);
}
main();
