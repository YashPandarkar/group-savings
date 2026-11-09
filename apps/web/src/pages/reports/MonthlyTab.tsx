import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, Spinner } from "../../components/ui";
import { BarChart } from "../../components/BarChart";
import { api, errorMessage } from "../../lib/api";
import { MONTH_NAMES } from "../../lib/format";
import { formatPaise } from "../../lib/money";

type Monthly = {
  year: number;
  months: { month: number; depositCount: number; depositsPaise: number; reversalsPaise: number; netPaise: number }[];
};

// One year = the annual savings report; each row = the monthly savings report.
export default function MonthlyTab() {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const thisYear = new Date(Date.now() + 330 * 60_000).getUTCFullYear();
  const [year, setYear] = useState(thisYear);

  const q = useQuery({
    queryKey: ["monthly-report", groupId, year],
    queryFn: () => api<Monthly>(`/api/groups/${groupId}/reports/monthly?year=${year}`),
  });

  const total = q.data?.months.reduce((s, m) => s + m.netPaise, 0) ?? 0;
  const count = q.data?.months.reduce((s, m) => s + m.depositCount, 0) ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled={year <= 2020} onClick={() => setYear((y) => y - 1)}>←</Button>
        <span className="w-20 text-center font-medium">{year}</span>
        <Button variant="secondary" disabled={year >= thisYear} onClick={() => setYear((y) => y + 1)}>→</Button>
      </div>

      {q.isPending && <Spinner />}
      {q.isError && <Alert kind="error">{errorMessage(q.error)}</Alert>}
      {q.data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card><p className="text-sm text-slate-500">Net savings collected in {year}</p><p className="mt-1 text-2xl font-bold">{formatPaise(total)}</p></Card>
            <Card><p className="text-sm text-slate-500">Deposits recorded</p><p className="mt-1 text-2xl font-bold">{count}</p></Card>
          </div>

          <BarChart
            ariaLabel={`Net deposits per month in ${year}`}
            format={formatPaise}
            data={q.data.months.map((m) => ({ label: MONTH_NAMES[m.month - 1].slice(0, 3), value: m.netPaise }))}
          />

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr><th className="px-4 py-3">Month</th><th className="px-4 py-3">Deposits</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Reversed</th><th className="px-4 py-3">Net</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.months.map((m) => (
                  <tr key={m.month}>
                    <td className="px-4 py-3">{MONTH_NAMES[m.month - 1]}</td>
                    <td className="px-4 py-3">{m.depositCount}</td>
                    <td className="px-4 py-3">{formatPaise(m.depositsPaise)}</td>
                    <td className="px-4 py-3">{m.reversalsPaise > 0 ? formatPaise(m.reversalsPaise) : "-"}</td>
                    <td className="px-4 py-3 font-medium">{formatPaise(m.netPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">Reversals count in the month they were made. Loan repayments and payouts are in the Loans and Withdrawals reports.</p>
        </>
      )}
    </div>
  );
}
