import { Link } from "react-router-dom";
import { formatDate } from "../lib/format";
import { formatPaise } from "../lib/money";
import { W_LABEL, type WStatus, type Withdrawal } from "../lib/withdrawals";
import { Badge } from "./Badge";
import { EmptyState } from "./ui";

const TONE = { PENDING: "amber", APPROVED: "indigo", COMPLETED: "green", REJECTED: "slate", CANCELLED: "slate" } as const;

export function WithdrawalStatusBadge({ status }: { status: WStatus }) {
  return <Badge tone={TONE[status]}>{W_LABEL[status]}</Badge>;
}

export function WithdrawalTable({ items }: { items: Withdrawal[] }) {
  if (items.length === 0) return <EmptyState title="No withdrawals to show" />;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-3">Requested</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Purpose</th>
            <th className="px-4 py-3">Amount</th><th className="px-4 py-3">Status</th><th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((w) => (
            <tr key={w.id}>
              <td className="px-4 py-3 whitespace-nowrap">{formatDate(w.requestedAt)}</td>
              <td className="px-4 py-3">{w.beneficiary ? `Payout to ${w.beneficiary.name}` : "Group expense"}</td>
              <td className="px-4 py-3">{w.purpose}</td>
              <td className="px-4 py-3 font-medium">{formatPaise(w.amountPaise)}</td>
              <td className="px-4 py-3"><WithdrawalStatusBadge status={w.status} /></td>
              <td className="px-4 py-3 text-right"><Link to={`/withdrawals/${w.id}`} className="font-medium text-indigo-600">View</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
