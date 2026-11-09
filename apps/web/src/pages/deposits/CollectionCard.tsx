import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, EmptyState, Spinner } from "../../components/ui";
import { Badge } from "../../components/Badge";
import type { Contribution } from "../../components/ContributionTable";
import { api, errorMessage } from "../../lib/api";
import { MONTH_NAMES } from "../../lib/format";
import { formatPaise } from "../../lib/money";

type Overview = {
  period: { year: number; month: number };
  summary: {
    expectedPaise: number; collectedPaise: number; pendingPaise: number;
    counts: { paid: number; partial: number; pending: number; overdue: number; waived: number };
  };
  items: (Contribution & { memberName: string })[];
};
type Period = { year: number; month: number };

const index = (p: Period) => p.year * 12 + (p.month - 1);
const fromIndex = (i: number): Period => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });
function currentPeriod(): Period {
  const d = new Date(Date.now() + 330 * 60_000); // India time
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export default function CollectionCard({ groupId }: { groupId: string }) {
  const now = currentPeriod();
  const [period, setPeriod] = useState<Period>(now);
  const q = useQuery({
    queryKey: ["contributions", groupId, period.year, period.month],
    queryFn: () => api<Overview>(`/api/groups/${groupId}/contributions?year=${period.year}&month=${period.month}`),
  });
  const data = q.data;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Monthly collection</h2>
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={period.year <= 2020 && period.month === 1} onClick={() => setPeriod(fromIndex(index(period) - 1))}>←</Button>
          <span className="w-36 text-center text-sm font-medium">{MONTH_NAMES[period.month - 1]} {period.year}</span>
          <Button variant="secondary" disabled={index(period) >= index(now)} onClick={() => setPeriod(fromIndex(index(period) + 1))}>→</Button>
        </div>
      </div>

      {q.isPending && <Spinner />}
      {q.isError && <Alert kind="error">{errorMessage(q.error)}</Alert>}
      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card><p className="text-sm text-slate-500">Expected</p><p className="mt-1 text-xl font-bold">{formatPaise(data.summary.expectedPaise)}</p></Card>
            <Card><p className="text-sm text-slate-500">Collected</p><p className="mt-1 text-xl font-bold text-green-700">{formatPaise(data.summary.collectedPaise)}</p></Card>
            <Card><p className="text-sm text-slate-500">Pending</p><p className="mt-1 text-xl font-bold text-amber-700">{formatPaise(data.summary.pendingPaise)}</p>
              <p className="mt-1 text-xs text-slate-500">{data.summary.counts.paid} paid · {data.summary.counts.partial} partly · {data.summary.counts.pending} pending · {data.summary.counts.overdue} overdue</p></Card>
          </div>

          <div className="mt-4">
            {data.items.length === 0 ? (
              <EmptyState title="No contributions for this month" />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr><th className="px-4 py-3">Member</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">Paid</th><th className="px-4 py-3">Status</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.items.map((c) => (
                      <tr key={c.id}>
                        <td className="px-4 py-3 font-medium">{c.memberName}</td>
                        <td className="px-4 py-3">{formatPaise(c.expectedPaise)}</td>
                        <td className="px-4 py-3">{formatPaise(c.paidPaise)}</td>
                        <td className="px-4 py-3">
                          {c.overdue ? <Badge tone="red">Overdue</Badge>
                            : c.status === "PAID" ? <Badge tone="green">{c.paidLate ? "Paid late" : "Paid"}</Badge>
                            : c.status === "PARTIAL" ? <Badge tone="amber">Partly paid</Badge>
                            : c.status === "WAIVED" ? <Badge>Waived</Badge>
                            : <Badge tone="amber">Pending</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
