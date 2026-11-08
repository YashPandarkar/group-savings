import { describe, expect, it } from "vitest";
import type { InterestMethod, RepaymentFrequency } from "@prisma/client";
import { computeSchedule } from "../src/lib/interest";
import { installmentDueDate } from "../src/lib/loanDates";
import { allocateRepayment, deriveLoanStatus, type InstallmentLike } from "../src/lib/loanRules";

const terms = (
  principalPaise: bigint, installmentCount: number, interestMethod: InterestMethod,
  interestRateBps: number, repaymentFrequency: RepaymentFrequency = "MONTHLY"
) => ({ principalPaise, installmentCount, interestMethod, interestRateBps, repaymentFrequency });

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

describe("computeSchedule", () => {
  it("no interest: even split, the last installment absorbs the remainder", () => {
    const rows = computeSchedule(terms(100000n, 3, "NONE", 0)); // ₹1,000.00 in 3
    expect(rows.map((r) => r.totalPaise)).toEqual([33333n, 33333n, 33334n]);
    expect(sum(rows.map((r) => r.interestPaise))).toBe(0n);
  });

  it("flat: ₹10,000 at 12% a year over 12 months costs exactly ₹1,200 interest", () => {
    const rows = computeSchedule(terms(1_000_000n, 12, "FLAT", 1200));
    expect(sum(rows.map((r) => r.interestPaise))).toBe(120000n);
    expect(sum(rows.map((r) => r.totalPaise))).toBe(1_120_000n);
    expect(rows[0]).toMatchObject({ principalPaise: 83333n, interestPaise: 10000n, totalPaise: 93333n });
    expect(rows[11].principalPaise).toBe(83337n);
  });

  it("flat interest scales with the term: 6 months costs half of 12", () => {
    expect(sum(computeSchedule(terms(1_000_000n, 6, "FLAT", 1200)).map((r) => r.interestPaise))).toBe(60000n);
  });

  it("reducing balance: ₹1,00,000 at 12% over 12 months has an EMI of about ₹8,884.88", () => {
    const rows = computeSchedule(terms(10_000_000n, 12, "REDUCING_BALANCE", 1200));
    expect(rows[0].interestPaise).toBe(100000n); // 1% of the full balance
    expect(rows[0].totalPaise).toBe(888488n);
    expect(sum(rows.map((r) => r.principalPaise))).toBe(10_000_000n);
    expect(rows[11].totalPaise - 888488n <= 12n && 888488n - rows[11].totalPaise <= 12n).toBe(true);
    expect(rows[1].interestPaise < rows[0].interestPaise).toBe(true); // interest falls as the balance falls
  });

  it("holds for many combinations: principal adds up, every row positive, totals consistent", () => {
    for (const P of [10000n, 123457n, 5_000_001n, 99_999_999n]) {
      for (const n of [1, 3, 7, 12, 60]) {
        for (const method of ["NONE", "FLAT", "REDUCING_BALANCE"] as const) {
          for (const bps of [0, 100, 1200, 3650, 10000]) {
            for (const f of ["MONTHLY", "WEEKLY"] as const) {
              const rows = computeSchedule(terms(P, n, method, bps, f));
              expect(rows).toHaveLength(n);
              expect(sum(rows.map((r) => r.principalPaise))).toBe(P);
              for (const r of rows) {
                expect(r.totalPaise).toBe(r.principalPaise + r.interestPaise);
                expect(r.totalPaise > 0n && r.interestPaise >= 0n && r.principalPaise >= 0n).toBe(true);
              }
              if (method === "NONE" || bps === 0) expect(sum(rows.map((r) => r.interestPaise))).toBe(0n);
            }
          }
        }
      }
    }
  });

  it("rejects impossible terms", () => {
    expect(() => computeSchedule(terms(10000n, 0, "NONE", 0))).toThrow();
    expect(() => computeSchedule(terms(10000n, 157, "NONE", 0))).toThrow();
    expect(() => computeSchedule(terms(0n, 3, "NONE", 0))).toThrow();
    expect(() => computeSchedule(terms(500n, 12, "NONE", 0))).toThrow(/too small/);
    expect(() => computeSchedule(terms(10000n, 3, "FLAT", 10001))).toThrow();
    expect(() => computeSchedule(terms(10000n, 3, "FLAT", 12.5))).toThrow();
  });
});

describe("installmentDueDate", () => {
  it("monthly keeps the day of month, clamped to the month end, at the end of the day in IST", () => {
    const base = new Date("2026-01-31T10:00:00+05:30");
    expect(istDate(installmentDueDate(base, 1, "MONTHLY"))).toBe("2026-02-28");
    expect(istDate(installmentDueDate(base, 2, "MONTHLY"))).toBe("2026-03-31");
    expect(istDate(installmentDueDate(new Date("2028-01-31T10:00:00+05:30"), 1, "MONTHLY"))).toBe("2028-02-29");
    expect(istDate(installmentDueDate(new Date("2026-11-15T10:00:00+05:30"), 2, "MONTHLY"))).toBe("2027-01-15");
    const d = installmentDueDate(base, 1, "MONTHLY");
    expect(new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 19)).toBe("23:59:59");
  });

  it("weekly adds 7 days each time", () => {
    const base = new Date("2026-01-31T10:00:00+05:30");
    expect(istDate(installmentDueDate(base, 1, "WEEKLY"))).toBe("2026-02-07");
    expect(istDate(installmentDueDate(base, 2, "WEEKLY"))).toBe("2026-02-14");
  });
});

describe("allocateRepayment and statuses", () => {
  const inst = (number: number, paid = 0n): InstallmentLike => ({
    id: `i${number}`, number, dueDate: new Date(Date.now() + number * 86_400_000 * 30),
    principalPaise: 25000n, interestPaise: 1000n, totalDuePaise: 26000n, paidPaise: paid,
  });

  it("pays the oldest installment first, interest before principal", () => {
    const { allocations, leftover } = allocateRepayment([inst(3), inst(1), inst(2)], 60000n);
    expect(leftover).toBe(0n);
    expect(allocations.map((a) => [a.number, a.amountPaise])).toEqual([[1, 26000n], [2, 26000n], [3, 8000n]]);
    expect(allocations[2]).toMatchObject({ interestPaise: 1000n, principalPaise: 7000n, fullyPaid: false });
  });

  it("finishes a part-paid installment before moving on, and reports leftovers", () => {
    const part = inst(1, 10000n); // 1000 interest + 9000 principal already paid
    const { allocations } = allocateRepayment([part, inst(2)], 16000n);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ number: 1, interestPaise: 0n, principalPaise: 16000n, fullyPaid: true });
    expect(allocateRepayment([inst(1)], 30000n).leftover).toBe(4000n);
  });

  it("derives the loan status from payments and the clock", () => {
    const now = new Date();
    const future = new Date(now.getTime() + 86_400_000);
    const past = new Date(now.getTime() - 86_400_000);
    const mk = (paid: bigint, dueDate: Date) => ({ totalDuePaise: 100n, paidPaise: paid, dueDate });
    expect(deriveLoanStatus([mk(0n, future)], now)).toBe("DISBURSED");
    expect(deriveLoanStatus([mk(100n, future), mk(0n, future)], now)).toBe("ACTIVE");
    expect(deriveLoanStatus([mk(40n, future)], now)).toBe("PARTIALLY_PAID");
    expect(deriveLoanStatus([mk(0n, past)], now)).toBe("OVERDUE");
    expect(deriveLoanStatus([mk(100n, past), mk(0n, future)], now)).toBe("ACTIVE");
    expect(deriveLoanStatus([mk(100n, past)], now)).toBe("COMPLETED");
  });
});
