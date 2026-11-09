import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Card, PageHeader, Spinner } from "../../components/ui";
import { LoanStatusBadge } from "../../components/LoanStatusBadge";
import { InstallmentTable, PreviewTable } from "../../components/Schedule";
import { api, errorMessage } from "../../lib/api";
import { formatDate, formatDateTime } from "../../lib/format";
import { LIVE_LOAN, type Loan } from "../../lib/loans";
import { formatPaise } from "../../lib/money";
import { useMembers } from "../../lib/queries";
import { isAdmin } from "../../lib/types";
import LoanActions from "./LoanActions";
import RecordRepaymentCard from "./RecordRepaymentCard";
import RepayCard from "./RepayCard";

type Repayment = {
  id: string; installmentNumber: number | null; amountPaise: number;
  principalPortionPaise: number; interestPortionPaise: number; method: string | null; paidAt: string;
};

function Stat({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <Card>
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone || "text-slate-900"}`}>{value}</p>
    </Card>
  );
}

export default function LoanDetail() {
  const { loanId } = useParams();
  const { me } = useAuth();
  const myRole = me!.membership!.role;
  const members = useMembers();

  const loanQ = useQuery({
    queryKey: ["loan", loanId],
    queryFn: () => api<{ loan: Loan }>(`/api/loans/${loanId}`),
  });
  const repayments = useQuery({
    queryKey: ["loan-repayments", loanId],
    enabled: loanQ.isSuccess,
    queryFn: () => api<{ repayments: Repayment[] }>(`/api/loans/${loanId}/repayments`),
  });

  if (loanQ.isPending) return <Spinner />;
  if (loanQ.isError) {
    return (
      <>
        <Alert kind="error">{errorMessage(loanQ.error)}</Alert>
        <Link to="/loans" className="mt-4 inline-block text-indigo-600">Back to loans</Link>
      </>
    );
  }

  const l = loanQ.data.loan;
  const isBorrower = l.borrower.userId === me!.user.id;
  const borrowerRole = members.data?.members.find((m) => m.userId === l.borrower.userId)?.role;
  // The President decides everyone's loans, except their own: the Vice President decides that one.
  const needed = borrowerRole === "PRESIDENT" ? "VICE_PRESIDENT" : "PRESIDENT";
  const canReview = !isBorrower && isAdmin(myRole);
  const canDecide = !isBorrower && myRole === needed;
  const live = LIVE_LOAN.includes(l.status);
  const hasSchedule = (l.installments?.length ?? 0) > 0;

  return (
    <>
      <Link to="/loans" className="mb-4 inline-block text-sm text-indigo-600">← All loans</Link>
      <PageHeader
        title={`Loan of ${formatPaise(l.principalPaise)}`}
        subtitle={`${l.borrower.name} · ${l.purpose}`}
        action={<LoanStatusBadge status={l.status} />}
      />

      <div className="space-y-6">
        {l.status === "APPROVED" && <Alert kind="info">Approved means authorised. <strong>No money has been sent</strong> until the disbursement is recorded.</Alert>}
        {l.status === "REJECTED" && l.rejectionReason && <Alert kind="warning">Closed: {l.rejectionReason}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Borrowed" value={formatPaise(l.principalPaise)} />
          <Stat label="Total to repay" value={l.totalRepayablePaise === null ? "-" : formatPaise(l.totalRepayablePaise)} />
          <Stat label="Paid so far" value={formatPaise(l.paidPaise)} tone="text-green-700" />
          <Stat label="Outstanding" value={l.outstandingPaise === null ? "-" : formatPaise(l.outstandingPaise)} />
        </div>
        {l.overdueAmountPaise > 0 && <Alert kind="error">{formatPaise(l.overdueAmountPaise)} is overdue.</Alert>}

        <Card>
          <h2 className="text-lg font-semibold">Terms</h2>
          <p className="mt-1 text-sm text-slate-700">{l.policy}</p>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
            <div><dt className="text-slate-500">Installments</dt><dd className="font-medium">{l.installmentCount} ({l.repaymentFrequency.toLowerCase()})</dd></div>
            <div><dt className="text-slate-500">Requested</dt><dd className="font-medium">{formatDateTime(l.requestedAt)}</dd></div>
            {l.approvedAt && <div><dt className="text-slate-500">Approved</dt><dd className="font-medium">{formatDate(l.approvedAt)}{l.approvedBy ? ` by ${l.approvedBy}` : ""}</dd></div>}
            {l.disbursedAt && <div><dt className="text-slate-500">Disbursed</dt><dd className="font-medium">{formatDate(l.disbursedAt)}{l.disbursedBy ? ` by ${l.disbursedBy}` : ""}</dd></div>}
            {l.disbursementRef && <div><dt className="text-slate-500">Transfer reference</dt><dd className="font-medium">{l.disbursementRef}</dd></div>}
            {l.nextDue && <div><dt className="text-slate-500">Next due</dt><dd className="font-medium">{formatDate(l.nextDue.dueDate)} ({formatPaise(l.nextDue.remainingPaise)})</dd></div>}
          </dl>
        </Card>

        <LoanActions loan={l} canReview={canReview} canDecide={canDecide} isBorrower={isBorrower}
          deciderLabel={needed === "PRESIDENT" ? "the President" : "the Vice President"} />

        <div>
          <h2 className="mb-3 text-lg font-semibold">{hasSchedule ? "Installment schedule" : "Planned schedule"}</h2>
          {hasSchedule && l.installments && <InstallmentTable rows={l.installments} />}
          {!hasSchedule && l.schedulePreview && (
            <>
              <PreviewTable rows={l.schedulePreview} />
              <p className="mt-2 text-xs text-slate-500">These amounts are fixed when the loan is approved. Due dates are set when the money is sent.</p>
            </>
          )}
          {!hasSchedule && !l.schedulePreview && <p className="text-sm text-slate-500">No schedule for this loan.</p>}
        </div>

        {live && isBorrower && <RepayCard loan={l} />}
        {live && canReview && <RecordRepaymentCard loan={l} />}

        {(hasSchedule || (repayments.data?.repayments.length ?? 0) > 0) && (
          <div>
            <h2 className="mb-3 text-lg font-semibold">Repayment history</h2>
            {repayments.isError && <Alert kind="error">{errorMessage(repayments.error)}</Alert>}
            {repayments.data && repayments.data.repayments.length === 0 && <p className="text-sm text-slate-500">No repayments yet.</p>}
            {repayments.data && repayments.data.repayments.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Installment</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Principal</th><th className="px-4 py-3">Interest</th><th className="px-4 py-3">Method</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {repayments.data.repayments.map((r) => (
                      <tr key={r.id}>
                        <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(r.paidAt)}</td>
                        <td className="px-4 py-3">{r.installmentNumber ?? "-"}</td>
                        <td className="px-4 py-3 font-medium">{formatPaise(r.amountPaise)}</td>
                        <td className="px-4 py-3">{formatPaise(r.principalPortionPaise)}</td>
                        <td className="px-4 py-3">{formatPaise(r.interestPortionPaise)}</td>
                        <td className="px-4 py-3">{r.method ? r.method.replace("_", " ").toLowerCase() : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
