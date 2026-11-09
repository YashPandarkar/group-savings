import { formatPaise } from "../lib/money";
import { EmptyState } from "./ui";
import { Badge } from "./Badge";

export type Contribution = {
  id: string; userId: string; periodYear: number; periodMonth: number; dueDate: string;
  expectedPaise: number; paidPaise: number; remainingPaise: number;
  status: "PENDING" | "PARTIAL" | "PAID" | "WAIVED"; overdue: boolean; paidLate: boolean;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function ContributionTable({ items }: { items: Contribution[] }) {
  if (items.length === 0) return <EmptyState title="No contributions yet" />;
  return (
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
          {items.map((c) => (
            <tr key={c.id}>
              <td className="px-4 py-3">{MONTHS[c.periodMonth - 1]} {c.periodYear}</td>
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
  );
}
