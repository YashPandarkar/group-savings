import { prisma } from "../config/prisma";
import { periodOf } from "../lib/period";
import { ensureContributions } from "../modules/contributions/contributions.service";
import { syncGroupLoans } from "../modules/loans/loans.service";
import { reconcilePayments } from "../modules/payments/payments.reconcile";

// Runs the recurring jobs. Every job is idempotent, so a restart, a crash half-way, or an accidental
// second copy of this process can't double-apply anything. Keep to one copy anyway.
const MINUTE = 60_000;
type Job = { name: string; everyMs: number; run: () => Promise<string> };

const jobs: Job[] = [
  {
    name: "contributions",
    everyMs: 6 * 60 * MINUTE,
    run: async () => {
      const { year, month } = periodOf(new Date());
      const groups = await prisma.group.findMany({ select: { id: true } });
      let created = 0;
      for (const g of groups) created += await ensureContributions(prisma, g.id, year, month);
      return `${created} new rows for ${groups.length} groups`;
    },
  },
  {
    name: "loans",
    everyMs: 6 * 60 * MINUTE,
    run: async () => {
      const groups = await prisma.group.findMany({ select: { id: true } });
      for (const g of groups) await syncGroupLoans(g.id);
      return `synced ${groups.length} groups`;
    },
  },
  {
    name: "payments",
    everyMs: 10 * MINUTE,
    run: async () => JSON.stringify(await reconcilePayments()),
  },
];

const running = new Set<string>();
let stopping = false;

async function runJob(job: Job): Promise<void> {
  if (stopping || running.has(job.name)) return; // never overlap with itself
  running.add(job.name);
  const started = Date.now();
  try {
    const result = await job.run();
    console.log(`[jobs] ${job.name}: ${result} (${Date.now() - started} ms)`);
  } catch (e) {
    console.error(`[jobs] ${job.name} FAILED:`, e instanceof Error ? e.message : e);
  } finally {
    running.delete(job.name);
  }
}

const timers = jobs.map((job) => {
  void runJob(job); // once at start-up, then on its schedule
  return setInterval(() => void runJob(job), job.everyMs);
});
console.log(`[jobs] Jobs running: ${jobs.map((j) => `${j.name} every ${j.everyMs / MINUTE} min`).join(", ")}`);

async function shutdown(signal: string): Promise<void> {
  console.log(`[jobs] ${signal} received, stopping...`);
  stopping = true;
  for (const t of timers) clearInterval(t);
  for (let i = 0; i < 50 && running.size > 0; i++) await new Promise((r) => setTimeout(r, 200));
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
