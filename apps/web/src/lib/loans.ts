import type { InterestMethod } from "./types";

export type LoanStatus =
  | "PENDING" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "DISBURSED"
  | "ACTIVE" | "PARTIALLY_PAID" | "COMPLETED" | "OVERDUE";

export const LOAN_STATUSES: LoanStatus[] = [
  "PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "DISBURSED", "ACTIVE", "PARTIALLY_PAID", "COMPLETED", "OVERDUE",
];

export const LOAN_STATUS_LABEL: Record<LoanStatus, string> = {
  PENDING: "Pending", UNDER_REVIEW: "Under review", APPROVED: "Approved", REJECTED: "Rejected",
  DISBURSED: "Disbursed", ACTIVE: "Active", PARTIALLY_PAID: "Partly paid", COMPLETED: "Completed", OVERDUE: "Overdue",
};

export const LIVE_LOAN: LoanStatus[] = ["DISBURSED", "ACTIVE", "PARTIALLY_PAID", "OVERDUE"];

export type Installment = {
  id: string; number: number; dueDate: string;
  principalPaise: number; interestPaise: number; totalDuePaise: number;
  paidPaise: number; remainingPaise: number; principalPaidPaise: number; interestPaidPaise: number;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID" | "OVERDUE"; overdue: boolean; paidAt: string | null;
};

export type PreviewRow = { number: number; principalPaise: number; interestPaise: number; totalPaise: number };

export type Loan = {
  id: string; groupId: string;
  borrower: { userId: string; name: string };
  principalPaise: number; purpose: string; installmentCount: number;
  repaymentFrequency: "WEEKLY" | "MONTHLY";
  interestMethod: InterestMethod; interestRateBps: number; policy: string; status: LoanStatus;
  totalRepayablePaise: number | null; totalInterestPaise: number | null;
  paidPaise: number; outstandingPaise: number | null; outstandingPrincipalPaise: number | null; overdueAmountPaise: number;
  nextDue: { number: number; dueDate: string; remainingPaise: number } | null;
  requestedAt: string; reviewedAt: string | null; approvedAt: string | null; approvedBy: string | null;
  rejectionReason: string | null; disbursedAt: string | null; disbursedBy: string | null; disbursementRef: string | null;
  firstDueDate: string | null; schedulePreview: PreviewRow[] | null; installments?: Installment[];
};

export type LoanPage = { page: number; pageSize: number; total: number; items: Loan[] };
