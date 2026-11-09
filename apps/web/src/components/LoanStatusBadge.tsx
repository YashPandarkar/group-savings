import { Badge } from "./Badge";
import { LOAN_STATUS_LABEL, type LoanStatus } from "../lib/loans";

const TONE = {
  PENDING: "amber", UNDER_REVIEW: "amber", APPROVED: "indigo", REJECTED: "slate", DISBURSED: "indigo",
  ACTIVE: "green", PARTIALLY_PAID: "amber", COMPLETED: "green", OVERDUE: "red",
} as const;

export function LoanStatusBadge({ status }: { status: LoanStatus }) {
  return <Badge tone={TONE[status]}>{LOAN_STATUS_LABEL[status]}</Badge>;
}
