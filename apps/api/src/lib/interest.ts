import type { InterestMethod, RepaymentFrequency } from "@prisma/client";

// All amounts are integer PAISE. Rates are ANNUAL basis points (12% = 1200).
export type LoanTerms = {
  principalPaise: bigint;
  installmentCount: number;
  repaymentFrequency: RepaymentFrequency;
  interestMethod: InterestMethod;
  interestRateBps: number;
};

export type ScheduleRow = {
  number: number;
  principalPaise: bigint;
  interestPaise: bigint;
  totalPaise: bigint;
};

export const MAX_INSTALLMENTS = 156;
export const periodsPerYear = (f: RepaymentFrequency): number => (f === "WEEKLY" ? 52 : 12);

// a / b rounded half up, for non-negative BigInts.
const divRound = (a: bigint, b: bigint): bigint => (2n * a + b) / (2n * b);

// Splits total into n parts; the LAST part absorbs the remainder.
function splitEvenly(total: bigint, n: number): bigint[] {
  const count = BigInt(n);
  const base = total / count;
  const parts = Array<bigint>(n).fill(base);
  parts[n - 1] += total - base * count;
  return parts;
}

export function computeSchedule(t: LoanTerms): ScheduleRow[] {
  const n = t.installmentCount;
  if (!Number.isInteger(n) || n < 1 || n > MAX_INSTALLMENTS) {
    throw new Error(`Installments must be between 1 and ${MAX_INSTALLMENTS}.`);
  }
  if (!Number.isInteger(t.interestRateBps) || t.interestRateBps < 0 || t.interestRateBps > 10000) {
    throw new Error("Interest rate must be between 0% and 100% per year.");
  }
  const P = t.principalPaise;
  if (P <= 0n) throw new Error("The loan amount must be positive.");
  if (P < BigInt(n) * 100n) {
    throw new Error("The amount is too small for that many installments (each must be at least ₹1).");
  }

  const bps = BigInt(t.interestRateBps);
  const ppy = BigInt(periodsPerYear(t.repaymentFrequency));
  let principals: bigint[];
  let interests: bigint[];

  if (t.interestMethod === "NONE" || bps === 0n) {
    principals = splitEvenly(P, n);
    interests = principals.map(() => 0n);
  } else if (t.interestMethod === "FLAT") {
    // interest = principal x annual rate x (n / periods per year)
    const totalInterest = divRound(P * bps * BigInt(n), 10000n * ppy);
    principals = splitEvenly(P, n);
    interests = splitEvenly(totalInterest, n);
  } else {
    // Reducing balance. With periodic rate r = bps / b:
    //   EMI = P r (1+r)^n / ((1+r)^n - 1) = P bps (b+bps)^n / (b ((b+bps)^n - b^n))
    // computed exactly with BigInt, so no floating point anywhere.
    const b = 10000n * ppy;
    const N = BigInt(n);
    const growth = (b + bps) ** N;
    const emi = divRound(P * bps * growth, b * (growth - b ** N));

    principals = [];
    interests = [];
    let balance = P;
    for (let i = 1; i < n; i++) {
      const interest = divRound(balance * bps, b);
      let principal = emi - interest;
      if (principal < 0n) principal = 0n;
      if (principal > balance) principal = balance;
      principals.push(principal);
      interests.push(interest);
      balance -= principal;
    }
    principals.push(balance); // the last installment clears whatever is left
    interests.push(divRound(balance * bps, b));
  }

  const rows = principals.map((p, i) => ({
    number: i + 1,
    principalPaise: p,
    interestPaise: interests[i],
    totalPaise: p + interests[i],
  }));
  if (rows.some((r) => r.totalPaise <= 0n)) throw new Error("These terms produce an empty installment.");
  return rows;
}
