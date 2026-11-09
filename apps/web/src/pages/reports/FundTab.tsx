import { Alert, Card, Spinner } from "../../components/ui";
import { Badge } from "../../components/Badge";
import { errorMessage } from "../../lib/api";
import { TX_LABEL } from "../../lib/ledgerLabels";
import { formatPaise } from "../../lib/money";
import { useFundReport } from "../../lib/reports";

export default function FundTab() {
  const q = useFundReport(true);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert kind="error">{errorMessage(q.error)}</Alert>;
  const r = q.data;
  const totalSavings = r.memberBalances.reduce((s, b) => s + b.savingsPaise, 0);

  return (
    <div className="space-y-8">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card><p className="text-sm text-slate-500">Group fund (per records)</p><p className="mt-1 text-2xl font-bold">{formatPaise(r.fundBalancePaise)}</p></Card>
        <Card><p className="text-sm text-slate-500">Members' savings (total)</p><p className="mt-1 text-2xl font-bold">{formatPaise(totalSavings)}</p></Card>
      </div>
      <Alert kind="info">These figures come from the group's ledger. They are not a bank balance: compare them with the bank statement. Money lent out is part of members' savings but not in the bank, so the two totals differ.</Alert>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Member-wise savings</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Member</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Savings</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {r.memberBalances.map((b) => (
                <tr key={b.userId}>
                  <td className="px-4 py-3 font-medium">{b.name}</td>
                  <td className="px-4 py-3">{b.active ? <Badge tone="green">Member</Badge> : <Badge>Left the group</Badge>}</td>
                  <td className="px-4 py-3">{formatPaise(b.savingsPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Totals by type</h2>
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Type</th><th className="px-4 py-3">Records</th><th className="px-4 py-3">Total</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {r.byType.map((t) => (
                <tr key={t.type}><td className="px-4 py-3">{TX_LABEL[t.type] ?? t.type}</td><td className="px-4 py-3">{t.count}</td><td className="px-4 py-3">{formatPaise(t.totalPaise)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
