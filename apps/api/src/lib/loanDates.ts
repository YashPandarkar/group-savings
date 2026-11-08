import type { RepaymentFrequency } from "@prisma/client";
import { dueDateFor } from "./period";

const IST_OFFSET_MS = 330 * 60 * 1000;

export function istDay(date: Date) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1, day: ist.getUTCDate() };
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// Installment i (1-based) falls due i periods after `base`, at the END of that day in IST.
// Monthly keeps the original day of month, clamped (31 Jan -> 28 Feb -> 31 Mar).
export function installmentDueDate(base: Date, i: number, frequency: RepaymentFrequency): Date {
  const b = istDay(base);
  if (frequency === "WEEKLY") return dueDateFor(b.year, b.month, b.day + 7 * i); // Date.UTC rolls days over
  const index = b.year * 12 + (b.month - 1) + i;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return dueDateFor(year, month, Math.min(b.day, daysIn(year, month)));
}
