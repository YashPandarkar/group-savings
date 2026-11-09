import { useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, EmptyState, PageHeader, SelectField, Spinner, TextField } from "../../components/ui";
import { AmountCell } from "../../components/AmountCell";
import { Badge } from "../../components/Badge";
import { useToast } from "../../components/Toast";
import { api, downloadFile, errorMessage } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useDebounced } from "../../lib/hooks";
import { TX_LABEL, TX_STATUS_LABEL, TX_TYPES, type TxPage, type TxStatus } from "../../lib/ledgerLabels";
import { formatPaise } from "../../lib/money";
import { useMembers } from "../../lib/queries";
import { isAdmin } from "../../lib/types";

type Filters = {
  q: string; type: string; status: string; paymentStatus: string;
  from: string; to: string; memberUserId: string; sort: "date_desc" | "date_asc";
};
const EMPTY: Filters = { q: "", type: "", status: "", paymentStatus: "", from: "", to: "", memberUserId: "", sort: "date_desc" };
const STATUS_TONE: Record<TxStatus, "green" | "amber" | "slate"> = { POSTED: "green", REVERSED: "amber", REVERSAL: "slate" };

function toParams(f: Filters, q: string): URLSearchParams {
  const p = new URLSearchParams();
  if (q.trim()) p.set("q", q.trim());
  for (const k of ["type", "status", "paymentStatus", "from", "to", "memberUserId"] as const) {
    if (f[k]) p.set(k, f[k]);
  }
  p.set("sort", f.sort);
  return p;
}

export default function Transactions() {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const admin = isAdmin(me!.membership!.role);
  const toast = useToast();
  const members = useMembers();

  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const debouncedQ = useDebounced(filters.q, 400);

  function set<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  const invalidRange = filters.from !== "" && filters.to !== "" && filters.from > filters.to;
  const params = toParams(filters, debouncedQ);
  params.set("page", String(page));
  params.set("pageSize", "20");

  const list = useQuery({
    queryKey: ["transactions", groupId, params.toString()],
    enabled: !invalidRange,
    queryFn: () => api<TxPage>(`/api/groups/${groupId}/transactions?${params}`),
    placeholderData: keepPreviousData,
  });

  async function exportCsv() {
    setExporting(true);
    try {
      await downloadFile(`/api/groups/${groupId}/transactions/export.csv?${toParams(filters, filters.q)}`, "transactions.csv");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  }

  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const isFiltered = JSON.stringify(filters) !== JSON.stringify(EMPTY);

  return (
    <>
      <PageHeader
        title="Transactions"
        subtitle={admin ? "Every money record in the group." : "Your own money records."}
        action={<Button variant="secondary" loading={exporting} disabled={invalidRange} onClick={() => void exportCsv()}>Download CSV</Button>}
      />

      <Card className="mb-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <TextField label="Search" name="tx-q" value={filters.q} onChange={(v) => set("q", v)} placeholder="Member name or transaction ID" />
          <SelectField label="Type" name="tx-type" value={filters.type} onChange={(v) => set("type", v)}
            options={[{ value: "", label: "All types" }, ...TX_TYPES.map((t) => ({ value: t, label: TX_LABEL[t] }))]} />
          <SelectField label="Status" name="tx-status" value={filters.status} onChange={(v) => set("status", v)}
            options={[{ value: "", label: "All" }, ...(Object.keys(TX_STATUS_LABEL) as TxStatus[]).map((s) => ({ value: s, label: TX_STATUS_LABEL[s] }))]} />
          <SelectField label="Payment status" name="tx-pay" value={filters.paymentStatus} onChange={(v) => set("paymentStatus", v)}
            options={[{ value: "", label: "Any" }, ...["SUCCESS", "PENDING", "FAILED", "REFUNDED", "DISPUTED"].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))]} />
          <TextField label="From" name="tx-from" type="date" value={filters.from} onChange={(v) => set("from", v)} />
          <TextField label="To" name="tx-to" type="date" value={filters.to} onChange={(v) => set("to", v)} error={invalidRange ? "'To' must not be before 'From'" : undefined} />
          {admin && (
            <SelectField label="Member" name="tx-member" value={filters.memberUserId} onChange={(v) => set("memberUserId", v)}
              options={[{ value: "", label: "Everyone" }, ...(members.data?.members ?? []).map((m) => ({ value: m.userId, label: m.name }))]} />
          )}
          <SelectField label="Sort" name="tx-sort" value={filters.sort} onChange={(v) => set("sort", v === "date_asc" ? "date_asc" : "date_desc")}
            options={[{ value: "date_desc", label: "Newest first" }, { value: "date_asc", label: "Oldest first" }]} />
        </div>
        {isFiltered && (
          <div className="mt-4"><Button variant="secondary" onClick={() => { setFilters(EMPTY); setPage(1); }}>Clear filters</Button></div>
        )}
      </Card>

      {list.isPending && !invalidRange && <Spinner />}
      {list.isError && <Alert kind="error">{errorMessage(list.error)}</Alert>}
      {data && data.items.length === 0 && <EmptyState title="No transactions match" >{isFiltered ? "Try clearing some filters." : "Records appear here as money is recorded."}</EmptyState>}

      {data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Date</th><th className="px-4 py-3">Member</th><th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Amount</th><th className="px-4 py-3">Status</th>
                {admin && <th className="px-4 py-3">Fund after</th>}
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(t.occurredAt)}</td>
                  <td className="px-4 py-3">{t.memberName ?? "-"}</td>
                  <td className="px-4 py-3">{TX_LABEL[t.type] ?? t.type}</td>
                  <td className="px-4 py-3"><AmountCell amountPaise={t.amountPaise} bankDeltaPaise={t.bankDeltaPaise} /></td>
                  <td className="px-4 py-3"><Badge tone={STATUS_TONE[t.status]}>{TX_STATUS_LABEL[t.status]}</Badge></td>
                  {admin && <td className="px-4 py-3">{t.balanceAfterPaise === null || t.balanceAfterPaise === undefined ? "-" : formatPaise(t.balanceAfterPaise)}</td>}
                  <td className="px-4 py-3 text-right"><Link to={`/transactions/${t.id}`} className="font-medium text-indigo-600">Details</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-slate-600">Page {page} of {pages} ({data.total} records)</span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
      <p className="mt-4 text-xs text-slate-500">
        Green + is money coming into the group's records, red - is money going out. These records come from the group's ledger and are not a bank statement: compare them with your bank.
      </p>
    </>
  );
}
