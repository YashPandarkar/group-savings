import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Card, Spinner } from "../../components/ui";
import { WithdrawalTable } from "../../components/WithdrawalParts";
import { api, errorMessage } from "../../lib/api";
import { formatPaise } from "../../lib/money";
import type { WithdrawalReportData } from "../../lib/withdrawals";

export default function WithdrawalsTab() {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const q = useQuery({
    queryKey: ["withdrawals-report", groupId],
    queryFn: () => api<WithdrawalReportData>(`/api/groups/${groupId}/withdrawals/report`),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert kind="error">{errorMessage(q.error)}</Alert>;
  const s = q.data.summary;

  const cards: [string, string, string?][] = [
    ["Transfers recorded", formatPaise(s.completedPaise), `${formatPaise(s.payoutsCompletedPaise)} payouts, ${formatPaise(s.expensesCompletedPaise)} expenses`],
    ["Waiting for approval", String(s.awaitingApprovalCount), formatPaise(s.awaitingApprovalPaise)],
    ["Approved, not yet sent", String(s.awaitingTransferCount), `${formatPaise(s.awaitingTransferPaise)} reserved`],
    ["Rejected or withdrawn", String(s.rejectedCount + s.cancelledCount)],
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([label, value, hint]) => (
          <Card key={label}>
            <p className="text-sm text-slate-500">{label}</p>
            <p className="mt-1 text-xl font-bold">{value}</p>
            {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
          </Card>
        ))}
      </div>
      <WithdrawalTable items={q.data.items} />
      <p className="text-xs text-slate-500">“Transfer recorded” means an administrator recorded a transfer made outside the app.</p>
    </div>
  );
}
