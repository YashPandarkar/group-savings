export const TX_TYPES = [
  "MONTHLY_DEPOSIT", "ADDITIONAL_DEPOSIT", "LOAN_DISBURSEMENT", "LOAN_REPAYMENT",
  "GROUP_WITHDRAWAL", "REVERSAL", "REFUND", "ADJUSTMENT", "OPENING_CONTRIBUTION", "LOAN_INTEREST_PAYMENT",
] as const;

export const TX_LABEL: Record<string, string> = {
  MONTHLY_DEPOSIT: "Monthly deposit",
  ADDITIONAL_DEPOSIT: "Additional deposit",
  LOAN_DISBURSEMENT: "Loan disbursement",
  LOAN_REPAYMENT: "Loan repayment",
  GROUP_WITHDRAWAL: "Withdrawal",
  REVERSAL: "Reversal",
  REFUND: "Refund",
  ADJUSTMENT: "Adjustment",
  OPENING_CONTRIBUTION: "Opening contribution",
  LOAN_INTEREST_PAYMENT: "Loan interest",
};

export const ACCOUNT_LABEL: Record<string, string> = {
  BANK_CLEARING: "Group bank (per records)",
  MEMBER_SAVINGS: "Member savings",
  LOANS_RECEIVABLE: "Loans receivable",
  INTEREST_INCOME: "Interest income",
  GROUP_EQUITY: "Group equity",
};

export type TxStatus = "POSTED" | "REVERSED" | "REVERSAL";
export const TX_STATUS_LABEL: Record<TxStatus, string> = { POSTED: "Posted", REVERSED: "Reversed", REVERSAL: "Reversal" };

export type Tx = {
  id: string; occurredAt: string; type: string; description: string;
  memberUserId: string | null; memberName: string | null;
  amountPaise: number; bankDeltaPaise: number; status: TxStatus;
  reversalOfId: string | null; reversedById: string | null;
  method: string | null; paymentStatus: string | null; reference: string | null;
  recordedBy: string; approvedBy: string | null;
  evidenceNote?: string | null; balanceAfterPaise?: number | null;
};

export type TxPage = { page: number; pageSize: number; total: number; items: Tx[] };
