export type WStatus = "PENDING" | "APPROVED" | "REJECTED" | "COMPLETED" | "CANCELLED";

export const W_STATUSES: WStatus[] = ["PENDING", "APPROVED", "COMPLETED", "REJECTED", "CANCELLED"];

// Honest wording: "approved" never means "sent".
export const W_LABEL: Record<WStatus, string> = {
  PENDING: "Waiting for approval",
  APPROVED: "Approved, not sent",
  COMPLETED: "Transfer recorded",
  REJECTED: "Rejected",
  CANCELLED: "Withdrawn",
};

export type Withdrawal = {
  id: string;
  groupId: string;
  kind: "MEMBER_PAYOUT" | "GROUP_EXPENSE";
  amountPaise: number;
  purpose: string;
  status: WStatus;
  statusNote: string;
  beneficiary: { userId: string; name: string } | null;
  requestedAt: string;
  completedAt: string | null;
  paymentReference: string | null;
  // Administrators also receive these:
  requestedBy?: { userId: string; name: string };
  firstApprovalBy?: string | null;
  secondApprovalBy?: string | null;
  approvedAt?: string | null;
  secondApprovedAt?: string | null;
  rejectionReason?: string | null;
  method?: string | null;
  completedBy?: string | null;
};

export type WithdrawalPage = { page: number; pageSize: number; total: number; items: Withdrawal[] };

export type WithdrawalReportData = {
  summary: {
    completedPaise: number; payoutsCompletedPaise: number; expensesCompletedPaise: number;
    awaitingApprovalCount: number; awaitingApprovalPaise: number;
    awaitingTransferCount: number; awaitingTransferPaise: number;
    rejectedCount: number; cancelledCount: number;
  };
  items: Withdrawal[];
};
