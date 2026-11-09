import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { Alert, Card, EmptyState, PageHeader, Spinner } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { formatPaise } from "../lib/money";

type Summary = { fundBalancePaise: number; mySavingsPaise: number; note: string };
type Contribution = {
  id: string; periodYear: number; periodMonth: number; dueDate: string;
  expectedPaise: number; paidPaise: number; remainingPaise: number;
  status: "PENDING" | "PARTIAL" | "PAID" | "WAIVED"; overdue: boolean;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

export default function Dashboard() {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;

  const summary = useQuery({
    queryKey: ["summary", groupId],
    queryFn: () => api<Summary>(`/api/groups/${groupId}/transactions/summary`),
  });
  const mine = useQuery({
    queryKey: ["my-contributions", groupId],
    queryFn: () => api<{ items: Contribution[] }>(`/api/groups/${groupId}/contributions/me`),
  });

  const open = mine.data?.items.find((c) => c.status === "PENDING" || c.status === "PARTIAL");

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`Hello, ${me!.user.name}.`} />

      {summary.isError && <Alert kind="error">{errorMessage(summary.error)}</Alert>}
      {summary.isPending && <Spinner />}
      {summary.data && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label="Group fund (per records)" value={formatPaise(summary.data.fundBalancePaise)} hint="From the ledger, not a bank balance." />
          <Stat label="My savings" value={formatPaise(summary.data.mySavingsPaise)} />
          <Stat
            label="This month's contribution"
            value={open ? formatPaise(open.remainingPaise) + " due" : "All paid"}
            hint={open ? `${MONTHS[open.periodMonth - 1]} ${open.periodYear}${open.overdue ? " (overdue)" : ""}` : undefined}
          />
        </div>
      )}

      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">My recent contributions</h2>
        {mine.isError && <Alert kind="error">{errorMessage(mine.error)}</Alert>}
        {mine.isPending && <Spinner />}
        {mine.data && mine.data.items.length === 0 && <EmptyState title="No contributions yet" />}
        {mine.data && mine.data.items.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Month</th>
                  <th className="px-4 py-3">Due</th>
                  <th className="px-4 py-3">Paid</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {mine.data.items.slice(0, 6).map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3">{MONTHS[c.periodMonth - 1]} {c.periodYear}</td>
                    <td className="px-4 py-3">{formatPaise(c.expectedPaise)}</td>
                    <td className="px-4 py-3">{formatPaise(c.paidPaise)}</td>
                    <td className="px-4 py-3">{c.overdue ? "Overdue" : c.status.charAt(0) + c.status.slice(1).toLowerCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
