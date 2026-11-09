import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { Alert, Card, EmptyState, PageHeader, Spinner } from "../components/ui";
import { AmountCell } from "../components/AmountCell";
import { ContributionTable, type Contribution } from "../components/ContributionTable";
import { api, errorMessage } from "../lib/api";
import { formatDate, formatDateTime, MONTH_NAMES } from "../lib/format";
import { TX_LABEL, type TxPage } from "../lib/ledgerLabels";
import type { LoanPage } from "../lib/loans";
import { formatPaise } from "../lib/money";
import { useFundReport } from "../lib/reports";
import { isAdmin } from "../lib/types";

type Summary = { fundBalancePaise: number; mySavingsPaise: number };
type LoanReport = { summary: { loansDisbursedPaise: number; repaidPaise: number; outstandingTotalPaise: number; overduePaise: number; overdueLoans: number; activeLoans: number } };
type Overview = { summary: { expectedPaise: number; collectedPaise: number; pendingPaise: number } };

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <Card>
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${tone ?? "text-slate-900"}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

export default function Dashboard() {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const admin = isAdmin(me!.membership!.role);

  const summary = useQuery({ queryKey: ["summary", groupId], queryFn: () => api<Summary>(`/api/groups/${groupId}/transactions/summary`) });
  const mine = useQuery({ queryKey: ["my-contributions", groupId], queryFn: () => api<{ items: Contribution[] }>(`/api/groups/${groupId}/contributions/me`) });
  const loans = useQuery({ queryKey: ["loans", groupId, "all"], queryFn: () => api<LoanPage>(`/api/groups/${groupId}/loans?pageSize=100`) });
  const recent = useQuery({ queryKey: ["recent-transactions", groupId], queryFn: () => api<TxPage>(`/api/groups/${groupId}/transactions?pageSize=6`) });

  const fund = useFundReport(admin);
  const loanReport = useQuery({ queryKey: ["loans-outstanding", groupId], enabled: admin, queryFn: () => api<LoanReport>(`/api/groups/${groupId}/loans/outstanding`) });
  const collection = useQuery({ queryKey: ["contributions", groupId, "current"], enabled: admin, queryFn: () => api<Overview>(`/api/groups/${groupId}/contributions`) });

  const open = mine.data ? [...mine.data.items].reverse().find((c) => c.status === "PENDING" || c.status === "PARTIAL") : undefined;
  const myNext = (loans.data?.items ?? [])
    .filter((l) => l.borrower.userId === me!.user.id && l.nextDue)
    .sort((a, b) => a.nextDue!.dueDate.localeCompare(b.nextDue!.dueDate))[0];
  const memberSavings = fund.data?.memberBalances.reduce((s, b) => s + b.savingsPaise, 0);
  const s = loanReport.data?.summary;

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`Hello, ${me!.user.name}.`} />

      {summary.isError && <Alert kind="error">{errorMessage(summary.error)}</Alert>}
      {summary.isPending && <Spinner />}
      {summary.data && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Available fund (per records)" value={formatPaise(summary.data.fundBalancePaise)} hint="From the ledger, not a bank balance. Approved but unsent loans and withdrawals are reserved from this." />
          <Stat label="My savings" value={formatPaise(summary.data.mySavingsPaise)} />
          <Stat
            label="My contribution due"
            value={open ? formatPaise(open.remainingPaise) : "All paid"}
            hint={open ? `${MONTH_NAMES[open.periodMonth - 1]} ${open.periodYear}${open.overdue ? " (overdue)" : ""}` : undefined}
            tone={open?.overdue ? "text-red-700" : undefined}
          />
          <Stat
            label="My next installment"
            value={myNext?.nextDue ? formatPaise(myNext.nextDue.remainingPaise) : "None"}
            hint={myNext?.nextDue ? `Due ${formatDate(myNext.nextDue.dueDate)}` : "You have no loan repayments due."}
          />
        </div>
      )}

      {open && (
        <div className="mt-4"><Link to="/deposits" className="text-sm font-medium text-indigo-600">Pay my contribution →</Link></div>
      )}

      {admin && (
        <div className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">The group</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Members' savings (total)" value={memberSavings === undefined ? "…" : formatPaise(memberSavings)} />
            <Stat label="Loans issued (ever)" value={s ? formatPaise(s.loansDisbursedPaise) : "…"} hint={s ? `${s.activeLoans} live loans` : undefined} />
            <Stat label="Loans outstanding" value={s ? formatPaise(s.outstandingTotalPaise) : "…"} hint={s && s.overdueLoans > 0 ? `${formatPaise(s.overduePaise)} overdue` : undefined} tone={s && s.overdueLoans > 0 ? "text-amber-700" : undefined} />
            <Stat label="Loan repayments (total)" value={s ? formatPaise(s.repaidPaise) : "…"} />
          </div>
          {collection.data && (
            <div className="mt-4">
              <Card>
                <p className="text-sm font-medium text-slate-500">This month's collection</p>
                <p className="mt-2 text-lg font-bold">
                  {formatPaise(collection.data.summary.collectedPaise)} of {formatPaise(collection.data.summary.expectedPaise)}
                  <span className="ml-2 text-sm font-normal text-slate-500">({formatPaise(collection.data.summary.pendingPaise)} pending)</span>
                </p>
                <Link to="/deposits" className="mt-2 inline-block text-sm font-medium text-indigo-600">See who has paid →</Link>
              </Card>
            </div>
          )}
          {s && s.overdueLoans > 0 && <div className="mt-4"><Alert kind="warning">{s.overdueLoans} loan(s) are overdue. <Link to="/loans" className="font-medium underline">Review loans</Link>.</Alert></div>}
        </div>
      )}

      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent transactions</h2>
          <Link to="/transactions" className="text-sm font-medium text-indigo-600">See all</Link>
        </div>
        {recent.isPending && <Spinner />}
        {recent.isError && <Alert kind="error">{errorMessage(recent.error)}</Alert>}
        {recent.data && recent.data.items.length === 0 && <EmptyState title="No transactions yet" />}
        {recent.data && recent.data.items.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Member</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Amount</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {recent.data.items.map((t) => (
                  <tr key={t.id}>
                    <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(t.occurredAt)}</td>
                    <td className="px-4 py-3">{t.memberName ?? "-"}</td>
                    <td className="px-4 py-3"><Link to={`/transactions/${t.id}`} className="text-indigo-600">{TX_LABEL[t.type] ?? t.type}</Link></td>
                    <td className="px-4 py-3"><AmountCell amountPaise={t.amountPaise} bankDeltaPaise={t.bankDeltaPaise} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">My recent contributions</h2>
        {mine.isError && <Alert kind="error">{errorMessage(mine.error)}</Alert>}
        {mine.isPending && <Spinner />}
        {mine.data && <ContributionTable items={mine.data.items.slice(0, 6)} />}
      </div>
    </>
  );
}
