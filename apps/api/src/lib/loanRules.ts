import type { InstallmentStatus, LoanStatus } from "@prisma/client";

const DAY = 24 * 60 * 60 * 1000;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export type InstallmentLike = {
  id: string;
  number: number;
  dueDate: Date;
  principalPaise: bigint;
  interestPaise: bigint;
  totalDuePaise: bigint;
  paidPaise: bigint;
};

// Payments always go to interest first, so what's been paid splits deterministically.
export function paidSplit(i: Pick<InstallmentLike, "interestPaise" | "paidPaise">) {
  const interestPaid = min(i.paidPaise, i.interestPaise);
  return { interestPaid, principalPaid: i.paidPaise - interestPaid };
}

export function outstanding(i: InstallmentLike) {
  const { interestPaid, principalPaid } = paidSplit(i);
  const interest = i.interestPaise - interestPaid;
  const principal = i.principalPaise - principalPaid;
  return { interest, principal, total: interest + principal };
}

// The due DAY has started (due dates are end-of-day IST, so we look one day back).
export const isDue = (i: Pick<InstallmentLike, "dueDate">, now: Date): boolean =>
  i.dueDate.getTime() - DAY < now.getTime();

export type Allocation = {
  installmentId: string;
  number: number;
  amountPaise: bigint;
  interestPaise: bigint;
  principalPaise: bigint;
  newPaidPaise: bigint;
  fullyPaid: boolean;
};

// Oldest installment first; within an installment, interest before principal.
export function allocateRepayment(installments: InstallmentLike[], amount: bigint) {
  const allocations: Allocation[] = [];
  let left = amount;
  for (const inst of [...installments].sort((a, b) => a.number - b.number)) {
    if (left <= 0n) break;
    const o = outstanding(inst);
    if (o.total <= 0n) continue;
    const interest = min(left, o.interest);
    const principal = min(left - interest, o.principal);
    const here = interest + principal;
    allocations.push({
      installmentId: inst.id,
      number: inst.number,
      amountPaise: here,
      interestPaise: interest,
      principalPaise: principal,
      newPaidPaise: inst.paidPaise + here,
      fullyPaid: here === o.total,
    });
    left -= here;
  }
  return { allocations, leftover: left };
}

type StatusInput = Pick<InstallmentLike, "dueDate" | "totalDuePaise" | "paidPaise">;

export function deriveInstallmentStatus(i: StatusInput, now: Date): InstallmentStatus {
  if (i.paidPaise >= i.totalDuePaise) return "PAID";
  if (i.dueDate < now) return "OVERDUE";
  if (i.paidPaise > 0n) return "PARTIALLY_PAID";
  return "PENDING";
}

// For loans that have been disbursed.
export function deriveLoanStatus(insts: StatusInput[], now: Date): LoanStatus {
  if (insts.length > 0 && insts.every((i) => i.paidPaise >= i.totalDuePaise)) return "COMPLETED";
  if (insts.some((i) => i.paidPaise < i.totalDuePaise && i.dueDate < now)) return "OVERDUE";
  if (insts.some((i) => i.paidPaise > 0n && i.paidPaise < i.totalDuePaise)) return "PARTIALLY_PAID";
  if (insts.some((i) => i.paidPaise >= i.totalDuePaise)) return "ACTIVE";
  return "DISBURSED";
}
