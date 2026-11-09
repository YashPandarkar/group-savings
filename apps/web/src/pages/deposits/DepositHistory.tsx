import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Alert, Button, EmptyState, Spinner } from "../../components/ui";
import { Badge } from "../../components/Badge";
import { api, errorMessage } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { formatPaise } from "../../lib/money";

type Deposit = {
  id: string; userId: string; purpose: string; amountPaise: number; method: string; status: string;
  reference: string | null; source: "MANUAL" | "GATEWAY"; paidAt: string | null; createdAt: string; memberName: string;
};
type DepositPage = { page: number; pageSize: number; total: number; items: Deposit[] };

const STATUS_TONE: Record<string, "green" | "red" | "amber" | "slate"> = {
  SUCCESS: "green", FAILED: "red", REFUNDED: "amber", DISPUTED: "amber", PENDING: "slate", CREATED: "slate",
};
const PURPOSE: Record<string, string> = { MONTHLY_DEPOSIT: "Monthly", ADDITIONAL_DEPOSIT: "Additional" };

export default function DepositHistory({ groupId, admin }: { groupId: string; admin: boolean }) {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["deposits", groupId, page],
    queryFn: () => api<DepositPage>(`/api/groups/${groupId}/deposits?page=${page}&pageSize=10`),
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">{admin ? "All deposits" : "My deposits"}</h2>
      {q.isPending && <Spinner />}
      {q.isError && <Alert kind="error">{errorMessage(q.error)}</Alert>}
      {data && data.items.length === 0 && <EmptyState title="No deposits yet" />}
      {data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Date</th>
                {admin && <th className="px-4 py-3">Member</th>}
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((d) => (
                <tr key={d.id}>
                  <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(d.paidAt ?? d.createdAt)}</td>
                  {admin && <td className="px-4 py-3">{d.memberName}</td>}
                  <td className="px-4 py-3">{PURPOSE[d.purpose] ?? d.purpose}</td>
                  <td className="px-4 py-3 font-medium">{formatPaise(d.amountPaise)}</td>
                  <td className="px-4 py-3">{d.method.replace("_", " ").toLowerCase()}</td>
                  <td className="px-4 py-3"><Badge tone={STATUS_TONE[d.status] ?? "slate"}>{d.status.charAt(0) + d.status.slice(1).toLowerCase()}</Badge></td>
                  <td className="px-4 py-3"><Badge tone={d.source === "GATEWAY" ? "indigo" : "slate"}>{d.source === "GATEWAY" ? "Online" : "Recorded by admin"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-slate-600">Page {page} of {pages}</span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">
        “Recorded by admin” means an administrator entered a payment that arrived outside the app. Corrected (reversed) deposits are shown on the Transactions page.
      </p>
    </div>
  );
}
