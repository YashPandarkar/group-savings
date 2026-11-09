import { formatDate } from "../lib/format";
import { formatPaise } from "../lib/money";
import type { Installment, PreviewRow } from "../lib/loans";
import { Badge } from "./Badge";

// Before disbursement: the exact schedule the loan WILL have (due dates are set when the money is sent).
export function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr><th className="px-4 py-3">#</th><th className="px-4 py-3">Principal</th><th className="px-4 py-3">Interest</th><th className="px-4 py-3">Installment</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.number}>
              <td className="px-4 py-3">{r.number}</td>
              <td className="px-4 py-3">{formatPaise(r.principalPaise)}</td>
              <td className="px-4 py-3">{formatPaise(r.interestPaise)}</td>
              <td className="px-4 py-3 font-medium">{formatPaise(r.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InstallmentTable({ rows }: { rows: Installment[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th className="px-4 py-3">#</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">Principal</th>
            <th className="px-4 py-3">Interest</th><th className="px-4 py-3">Total</th><th className="px-4 py-3">Paid</th><th className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((i) => (
            <tr key={i.id}>
              <td className="px-4 py-3">{i.number}</td>
              <td className="px-4 py-3 whitespace-nowrap">{formatDate(i.dueDate)}</td>
              <td className="px-4 py-3">{formatPaise(i.principalPaise)}</td>
              <td className="px-4 py-3">{formatPaise(i.interestPaise)}</td>
              <td className="px-4 py-3 font-medium">{formatPaise(i.totalDuePaise)}</td>
              <td className="px-4 py-3">{formatPaise(i.paidPaise)}</td>
              <td className="px-4 py-3">
                {i.status === "PAID" ? <Badge tone="green">Paid</Badge>
                  : i.overdue ? <Badge tone="red">Overdue</Badge>
                  : i.status === "PARTIALLY_PAID" ? <Badge tone="amber">Partly paid</Badge>
                  : <Badge>Upcoming</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
