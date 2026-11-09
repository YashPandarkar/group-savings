import { prisma } from "../../config/prisma";
import { provider } from "../../lib/paymentProvider";
import { syncRemote } from "./payments.sync";

export type ReconcileOptions = {
  groupId?: string; // limit to one group (handy for tests and a future "refresh" button)
  olderThanMinutes?: number; // give webhooks a moment to arrive first
  abandonAfterHours?: number; // an order nobody paid for in this long is marked FAILED
  limit?: number;
};

// Asks the provider about every open order and applies anything we missed (a lost webhook,
// an API outage...). Safe to run as often as you like. Phase 16 schedules it.
export async function reconcilePayments(opts: ReconcileOptions = {}) {
  const olderThan = opts.olderThanMinutes ?? 5;
  const abandonAfter = opts.abandonAfterHours ?? 48;
  const now = Date.now();

  const orders = await prisma.paymentOrder.findMany({
    where: {
      ...(opts.groupId ? { groupId: opts.groupId } : {}),
      status: { in: ["CREATED", "PENDING"] },
      createdAt: { lt: new Date(now - olderThan * 60_000) },
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 200,
  });

  const summary = { checked: orders.length, applied: 0, updated: 0, abandoned: 0, errors: 0 };
  for (const order of orders) {
    try {
      const payments = await provider.fetchOrderPayments(order.providerOrderId);
      for (const p of payments) {
        const r = await syncRemote(p);
        if (r.outcome === "APPLIED") summary.applied++;
        else if (r.outcome === "UPDATED") summary.updated++;
      }
      // Nobody paid, or every attempt failed, and it has been a long time: stop watching this order.
      const noLiveAttempt = payments.every((p) => p.status === "failed");
      if (noLiveAttempt && order.status === "CREATED" && order.createdAt.getTime() < now - abandon(abandonAfter)) {
        const r = await prisma.paymentOrder.updateMany({ where: { id: order.id, status: "CREATED" }, data: { status: "FAILED" } });
        summary.abandoned += r.count;
      }
    } catch (e) {
      summary.errors++;
      console.error(`Reconcile failed for order ${order.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return summary;
}

const abandon = (hours: number) => hours * 60 * 60 * 1000;
