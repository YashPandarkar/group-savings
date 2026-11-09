import type {
  Contribution,
  LoanInstallment,
  LoanStatus,
  PaymentMethod,
  PaymentOrder,
  PaymentPurpose,
  PaymentStatus,
  PaymentTransaction,
  Prisma,
  TransactionType,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { audit } from "../../lib/audit";
import { lockGroup } from "../../lib/locks";
import { formatRupees } from "../../lib/money";
import { ensureMemberAccounts } from "../../lib/ledgerAccounts";
import { getAccountId, postJournal, type JournalLine } from "../../lib/ledger";
import { allocateRepayment, type Allocation } from "../../lib/loanRules";
import { provider, ProviderError } from "../../lib/paymentProvider";
import type { RemotePayment } from "../../lib/providers/types";
import { LIVE_STATUSES, refreshLoanStatus } from "../loans/loans.service";

type Tx = Prisma.TransactionClient;

export type DisputeHint = "OPENED" | "WON" | "LOST";
export type SyncOutcome = "APPLIED" | "UPDATED" | "UNCHANGED" | "IGNORED" | "MISMATCH";
export type SyncResult = {
  outcome: SyncOutcome;
  status: PaymentStatus | null;
  orderId: string | null;
  transactionId: string | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ───────────── small helpers ─────────────

function mapStatus(r: RemotePayment): PaymentStatus {
  if (r.status === "captured") return "SUCCESS";
  if (r.status === "refunded") return "REFUNDED";
  if (r.status === "failed") return "FAILED";
  return "PENDING"; // created, authorized (not yet captured)
}

const mapMethod = (m: string | null): PaymentMethod =>
  m === "upi" ? "UPI" : m === "card" ? "CARD" : m === "netbanking" ? "NETBANKING" : "OTHER";

// Only what we need. No emails, phone numbers or UPI IDs are stored.
const rawView = (r: RemotePayment) => ({
  id: r.id,
  orderId: r.orderId,
  amountPaise: r.amountPaise.toString(),
  currency: r.currency,
  status: r.status,
  method: r.method,
  amountRefundedPaise: r.amountRefundedPaise.toString(),
  errorCode: r.errorCode,
  errorDescription: r.errorDescription?.slice(0, 200) ?? null,
});

async function notifyAdmins(tx: Tx, groupId: string, type: string, title: string, body: string) {
  const admins = await tx.groupMember.findMany({
    where: { groupId, status: "ACTIVE", role: { in: ["PRESIDENT", "VICE_PRESIDENT"] } },
    select: { userId: true },
  });
  if (admins.length > 0) {
    await tx.notification.createMany({
      data: admins.map((a) => ({ userId: a.userId, groupId, type, title, body })),
    });
  }
}

const setStatus = (tx: Tx, row: PaymentTransaction, status: PaymentStatus, remote: RemotePayment) =>
  tx.paymentTransaction.update({ where: { id: row.id }, data: { status, rawPayload: rawView(remote) } });

// ───────────── the entry points ─────────────

// "What does the provider say about this payment?" then make our records agree.
export async function syncPayment(providerPaymentId: string, hint?: DisputeHint): Promise<SyncResult> {
  let remote: RemotePayment;
  try {
    remote = await provider.fetchPayment(providerPaymentId);
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "NOT_FOUND") {
      return { outcome: "IGNORED", status: null, orderId: null, transactionId: null };
    }
    throw e; // network or provider trouble: the caller should retry later
  }
  return syncRemote(remote, hint);
}

// Safe to call any number of times, from any number of places at once.
export async function syncRemote(remote: RemotePayment, hint?: DisputeHint): Promise<SyncResult> {
  const ignored: SyncResult = { outcome: "IGNORED", status: null, orderId: null, transactionId: null };
  if (!remote.orderId) return ignored;

  // Not one of our orders (the Razorpay account may serve other products): ignore.
  const order = await prisma.paymentOrder.findUnique({ where: { providerOrderId: remote.orderId } });
  if (!order) return ignored;

  // The provider's amount must equal what WE asked for. If not, record nothing and raise a flag.
  if (remote.amountPaise !== order.amountPaise || remote.currency !== order.currency) {
    await flagMismatch(order, remote);
    return { outcome: "MISMATCH", status: null, orderId: order.id, transactionId: null };
  }

  return prisma.$transaction(async (tx): Promise<SyncResult> => {
    // Everything that touches the group's money waits its turn here.
    await lockGroup(tx, order.groupId);

    const fresh = await tx.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    let row = await tx.paymentTransaction.findUnique({ where: { providerPaymentId: remote.id } });
    const target = mapStatus(remote);
    let outcome: SyncOutcome = "UNCHANGED";

    const log = (action: string, after: Record<string, string | null>) =>
      audit(
        { actorId: null, groupId: fresh.groupId, action, entityType: "PaymentTransaction", entityId: row!.id, after },
        tx
      );

    // 1. Bring OUR record up to what the provider says right now.
    if (!row) {
      if (target === "SUCCESS") {
        row = await applySuccess(tx, fresh, remote, null);
        outcome = "APPLIED";
      } else {
        row = await tx.paymentTransaction.create({
          data: {
            groupId: fresh.groupId,
            userId: fresh.userId,
            orderId: fresh.id,
            providerPaymentId: remote.id,
            purpose: fresh.purpose,
            amountPaise: fresh.amountPaise,
            method: mapMethod(remote.method),
            status: target,
            loanId: fresh.loanId,
            rawPayload: rawView(remote),
          },
        });
        outcome = "UPDATED";
      }
    } else if (row.status === "PENDING" && target !== "PENDING") {
      if (target === "SUCCESS") {
        row = await applySuccess(tx, fresh, remote, row);
        outcome = "APPLIED";
      } else {
        row = await setStatus(tx, row, target, remote);
        outcome = "UPDATED";
      }
    }

    // 2. Later events on a payment we already hold: refunds and disputes.
    //    We flag these for people. We do NOT rewrite the ledger automatically.
    const amountText = formatRupees(fresh.amountPaise);
    if (row.status === "SUCCESS" && target === "REFUNDED") {
      row = await setStatus(tx, row, "REFUNDED", remote);
      outcome = "UPDATED";
      await log("PAYMENT_REFUNDED", { providerPaymentId: remote.id });
      await notifyAdmins(tx, fresh.groupId, "PAYMENT_REFUNDED", "A payment was refunded",
        `The ${amountText} payment ${remote.id} was refunded by the provider. The ledger has NOT been changed: ` +
          "for a deposit, use Reverse on the transaction; for a loan repayment, correct it manually.");
    } else if (row.status === "SUCCESS" && hint === "OPENED") {
      row = await setStatus(tx, row, "DISPUTED", remote);
      outcome = "UPDATED";
      await log("PAYMENT_DISPUTED", { providerPaymentId: remote.id });
      await notifyAdmins(tx, fresh.groupId, "PAYMENT_DISPUTED", "A payment is disputed",
        `The customer's bank disputed the ${amountText} payment ${remote.id}. Respond in the payment provider's dashboard.`);
    } else if (row.status === "DISPUTED" && hint === "WON") {
      row = await setStatus(tx, row, "SUCCESS", remote);
      outcome = "UPDATED";
      await log("PAYMENT_DISPUTE_WON", { providerPaymentId: remote.id });
      await notifyAdmins(tx, fresh.groupId, "PAYMENT_DISPUTE_WON", "A dispute was resolved in your favour",
        `The dispute on payment ${remote.id} was won. The payment stands.`);
    } else if (hint === "LOST" && (row.status === "SUCCESS" || row.status === "DISPUTED")) {
      if (row.status === "SUCCESS") row = await setStatus(tx, row, "DISPUTED", remote);
      outcome = "UPDATED";
      await log("PAYMENT_DISPUTE_LOST", { providerPaymentId: remote.id });
      await notifyAdmins(tx, fresh.groupId, "PAYMENT_DISPUTE_LOST", "A dispute was lost",
        `The ${amountText} payment ${remote.id} was reversed by the customer's bank. The ledger has NOT been changed: correct the books manually.`);
    } else if (row.status === "DISPUTED" && target === "REFUNDED") {
      row = await setStatus(tx, row, "REFUNDED", remote);
      outcome = "UPDATED";
    }

    // 3. A partial refund keeps the payment "captured". Notice it, once per change.
    if (row.status === "SUCCESS" && remote.amountRefundedPaise > 0n && target !== "REFUNDED") {
      const prev = row.rawPayload as Record<string, unknown> | null;
      const previouslySeen = BigInt(String(prev?.amountRefundedPaise ?? "0"));
      if (remote.amountRefundedPaise > previouslySeen) {
        await tx.paymentTransaction.update({ where: { id: row.id }, data: { rawPayload: rawView(remote) } });
        await log("PAYMENT_PARTIAL_REFUND", { providerPaymentId: remote.id, refundedPaise: remote.amountRefundedPaise.toString() });
        await notifyAdmins(tx, fresh.groupId, "PAYMENT_PARTIAL_REFUND", "A payment was partly refunded",
          `${formatRupees(remote.amountRefundedPaise)} of payment ${remote.id} was refunded. The ledger has NOT been changed: correct the books manually.`);
        outcome = "UPDATED";
      }
    }

    // 4. Keep the order's status in step. A failed attempt doesn't fail the order: the member can retry.
    let nextOrder: PaymentStatus = fresh.status;
    if (row.status === "SUCCESS" || row.status === "REFUNDED" || row.status === "DISPUTED") nextOrder = row.status;
    else if (row.status === "PENDING" && (fresh.status === "CREATED" || fresh.status === "FAILED")) nextOrder = "PENDING";
    if (nextOrder !== fresh.status) {
      await tx.paymentOrder.update({ where: { id: fresh.id }, data: { status: nextOrder } });
    }

    return { outcome, status: row.status, orderId: fresh.id, transactionId: row.id };
  });
}

async function flagMismatch(order: PaymentOrder, remote: RemotePayment) {
  await prisma.$transaction(async (tx) => {
    // Only the first call flips the order, so admins are told once, not on every webhook retry.
    const flipped = await tx.paymentOrder.updateMany({
      where: { id: order.id, status: { in: ["CREATED", "PENDING"] } },
      data: { status: "FAILED" },
    });
    if (flipped.count !== 1) return;
    await audit(
      {
        actorId: null,
        groupId: order.groupId,
        action: "PAYMENT_MISMATCH",
        entityType: "PaymentOrder",
        entityId: order.id,
        after: {
          providerPaymentId: remote.id,
          expectedPaise: order.amountPaise.toString(),
          receivedPaise: remote.amountPaise.toString(),
          currency: remote.currency,
        },
      },
      tx
    );
    await notifyAdmins(tx, order.groupId, "PAYMENT_MISMATCH", "A payment did not match its order",
      `Payment ${remote.id} didn't match the order (expected ${formatRupees(order.amountPaise)}). ` +
        "Nothing was recorded. Check the payment provider's dashboard.");
  });
}

// ───────────── applying money that really arrived ─────────────

async function applySuccess(
  tx: Tx,
  order: PaymentOrder,
  remote: RemotePayment,
  existing: PaymentTransaction | null
): Promise<PaymentTransaction> {
  const groupId = order.groupId;
  const amount = order.amountPaise;
  const paidAt = remote.createdAt;
  const method = mapMethod(remote.method);

  const payer = await tx.user.findUniqueOrThrow({ where: { id: order.userId }, select: { name: true } });
  await ensureMemberAccounts(tx, groupId, order.userId);
  const bank = await getAccountId(tx, groupId, "BANK_CLEARING");
  const savings = await getAccountId(tx, groupId, "MEMBER_SAVINGS", order.userId);

  // ── Decide what this money pays for, using the situation RIGHT NOW. ──
  let purpose: PaymentPurpose = order.purpose;
  let journalType: TransactionType = "ADDITIONAL_DEPOSIT";
  let label = "Additional deposit";
  let contribution: Contribution | null = null;
  let loanRow: { id: string; status: LoanStatus; installments: LoanInstallment[] } | null = null;
  let allocations: Allocation[] = [];
  let principalTotal = 0n;
  let interestTotal = 0n;
  let toSavings = amount; // the part that becomes member savings
  let redirected: string | null = null; // set when we had to change what the order asked for

  if (order.purpose === "MONTHLY_DEPOSIT") {
    if (order.contributionId) {
      await tx.$queryRaw`SELECT "id" FROM "contributions" WHERE "id" = ${order.contributionId} FOR UPDATE`;
      const c = await tx.contribution.findUnique({ where: { id: order.contributionId } });
      if (c && (c.status === "PENDING" || c.status === "PARTIAL") && amount <= c.expectedPaise - c.paidPaise) {
        contribution = c;
      }
    }
    if (contribution) {
      journalType = "MONTHLY_DEPOSIT";
      label = `Monthly deposit (${MONTHS[contribution.periodMonth - 1]} ${contribution.periodYear})`;
    } else {
      purpose = "ADDITIONAL_DEPOSIT";
      redirected = "That month's contribution was already paid, so this payment was added to your savings as an additional deposit.";
    }
  } else if (order.purpose === "LOAN_REPAYMENT") {
    const loan = order.loanId
      ? await tx.loan.findFirst({
          where: { id: order.loanId, groupId },
          include: { installments: { orderBy: { number: "asc" } } },
        })
      : null;
    const live = loan && LIVE_STATUSES.includes(loan.status) ? loan : null;
    const result = live ? allocateRepayment(live.installments, amount) : { allocations: [] as Allocation[], leftover: amount };

    if (live && result.allocations.length > 0) {
      loanRow = live;
      allocations = result.allocations;
      for (const a of allocations) {
        principalTotal += a.principalPaise;
        interestTotal += a.interestPaise;
      }
      toSavings = result.leftover;
      journalType = "LOAN_REPAYMENT";
      label = "Loan repayment";
      if (toSavings > 0n) {
        redirected = `${formatRupees(toSavings)} was more than the loan needed, so it was added to your savings.`;
      }
    } else {
      purpose = "ADDITIONAL_DEPOSIT";
      redirected = "The loan was already fully repaid, so this payment was added to your savings.";
    }
  }

  // ── The payment record. ──
  const data = {
    groupId,
    userId: order.userId,
    orderId: order.id,
    providerPaymentId: remote.id,
    purpose,
    amountPaise: amount,
    method,
    status: "SUCCESS" as const,
    contributionId: contribution?.id ?? null,
    loanId: loanRow?.id ?? null,
    rawPayload: rawView(remote),
    paidAt,
  };
  const row = existing
    ? await tx.paymentTransaction.update({ where: { id: existing.id }, data })
    : await tx.paymentTransaction.create({ data });

  // ── Update the member's obligations. ──
  if (contribution) {
    const newPaid = contribution.paidPaise + amount;
    const done = newPaid >= contribution.expectedPaise;
    await tx.contribution.update({
      where: { id: contribution.id },
      data: { paidPaise: newPaid, status: done ? "PAID" : "PARTIAL", paidAt: done ? paidAt : contribution.paidAt },
    });
  }
  if (loanRow) {
    for (const a of allocations) {
      await tx.loanRepayment.create({
        data: {
          loanId: loanRow.id,
          groupId,
          userId: order.userId,
          installmentId: a.installmentId,
          amountPaise: a.amountPaise,
          principalPortionPaise: a.principalPaise,
          interestPortionPaise: a.interestPaise,
          paymentTransactionId: row.id,
          paidAt,
        },
      });
      await tx.loanInstallment.update({
        where: { id: a.installmentId },
        data: { paidPaise: a.newPaidPaise, ...(a.fullyPaid ? { paidAt } : {}) },
      });
    }
    const byId = new Map(allocations.map((a) => [a.installmentId, a]));
    const updated = loanRow.installments.map((i) => {
      const a = byId.get(i.id);
      return a ? { ...i, paidPaise: a.newPaidPaise } : i;
    });
    await refreshLoanStatus(tx, loanRow, updated, new Date());
  }

  // ── The ledger: cash in, split across what it paid for. Always balanced by construction. ──
  const lines: JournalLine[] = [{ accountId: bank, direction: "DEBIT", amountPaise: amount }];
  if (principalTotal > 0n) {
    const receivable = await getAccountId(tx, groupId, "LOANS_RECEIVABLE", order.userId);
    lines.push({ accountId: receivable, direction: "CREDIT", amountPaise: principalTotal });
  }
  if (interestTotal > 0n) {
    const income = await getAccountId(tx, groupId, "INTEREST_INCOME");
    lines.push({ accountId: income, direction: "CREDIT", amountPaise: interestTotal });
  }
  if (toSavings > 0n) lines.push({ accountId: savings, direction: "CREDIT", amountPaise: toSavings });

  const { journal } = await postJournal(tx, {
    groupId,
    type: journalType,
    description: `${label} from ${payer.name} (online, ${method})`,
    createdById: order.userId,
    paymentTransactionId: row.id,
    loanId: loanRow?.id,
    occurredAt: paidAt,
    idempotencyKey: `gateway:${remote.id}`,
    lines,
  });

  // ── Tell people, and leave an audit trail. ──
  const amountText = formatRupees(amount);
  await tx.notification.create({
    data: {
      userId: order.userId,
      groupId,
      type: "PAYMENT_RECEIVED",
      title: "Payment received",
      body: `Your payment of ${amountText} was received.${redirected ? ` ${redirected}` : ""}`,
    },
  });
  if (redirected) {
    await notifyAdmins(tx, groupId, "PAYMENT_REDIRECTED", "A payment was applied differently from its order",
      `${payer.name}'s ${amountText} payment (${remote.id}): ${redirected}`);
  }
  await audit(
    {
      actorId: order.userId,
      groupId,
      action: "PAYMENT_CONFIRMED",
      entityType: "PaymentTransaction",
      entityId: row.id,
      after: {
        providerPaymentId: remote.id,
        amountPaise: amount.toString(),
        purpose,
        journalId: journal.id,
        source: "GATEWAY",
        redirected,
      },
    },
    tx
  );
  return row;
}
