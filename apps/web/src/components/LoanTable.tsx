import { Link } from "react-router-dom";
import { formatDate } from "../lib/format";
import type { Loan } from "../lib/loans";
import { formatPaise } from "../lib/money";
import { LoanStatusBadge } from "./LoanStatusBadge";
import { EmptyState } from "./ui";

export function LoanTable({ loans, showBorrower }: { loans: Loan[]; showBorrower: boolean }) {
  if (loans.length === 0) return <EmptyState title="No loans to show" />;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            {showBorrower && <th className="px-4 py-3">Borrower</th>}
            <th className="px-4 py-3">Requested</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Outstanding</th><th className="px-4 py-3">Next due</th><th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {loans.map((l) => (
            <tr key={l.id}>
              {showBorrower && <td className="px-4 py-3 font-medium">{l.borrower.name}</td>}
              <td className="px-4 py-3 whitespace-nowrap">{formatDate(l.requestedAt)}</td>
              <td className="px-4 py-3">{formatPaise(l.principalPaise)}</td>
              <td className="px-4 py-3"><LoanStatusBadge status={l.status} /></td>
              <td className="px-4 py-3">{l.outstandingPaise === null ? "-" : formatPaise(l.outstandingPaise)}</td>
              <td className="px-4 py-3 whitespace-nowrap">{l.nextDue ? `${formatDate(l.nextDue.dueDate)} (${formatPaise(l.nextDue.remainingPaise)})` : "-"}</td>
              <td className="px-4 py-3 text-right"><Link to={`/loans/${l.id}`} className="font-medium text-indigo-600">View</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
