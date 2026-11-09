import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, PageHeader, SelectField, Spinner } from "../../components/ui";
import { WithdrawalTable } from "../../components/WithdrawalParts";
import { api, errorMessage } from "../../lib/api";
import { formatPaise } from "../../lib/money";
import { isAdmin } from "../../lib/types";
import { W_LABEL, W_STATUSES, type WithdrawalPage, type WithdrawalReportData } from "../../lib/withdrawals";
import RequestWithdrawalCard from "./RequestWithdrawalCard";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

export default function Withdrawals() {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const admin = isAdmin(me!.membership!.role);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [requesting, setRequesting] = useState(false);

  const list = useQuery({
    queryKey: ["withdrawals", groupId, status, page],
    queryFn: () => api<WithdrawalPage>(`/api/groups/${groupId}/withdrawals?page=${page}&pageSize=15${status ? `&status=${status}` : ""}`),
    placeholderData: keepPreviousData,
  });
  const report = useQuery({
    queryKey: ["withdrawals-report", groupId],
    enabled: admin,
    queryFn: () => api<WithdrawalReportData>(`/api/groups/${groupId}/withdrawals/report`),
  });

  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const s = report.data?.summary;

  return (
    <>
      <PageHeader
        title="Withdrawals"
        subtitle={admin ? "Payouts of members' savings and group expenses." : "Payouts made to you."}
        action={admin && !requesting ? <Button onClick={() => setRequesting(true)}>Request a withdrawal</Button> : undefined}
      />

      {!admin && <div className="mb-4"><Alert kind="info">Only the President and Vice President can request withdrawals. Here you see payouts made to you.</Alert></div>}
      {requesting && <div className="mb-6"><RequestWithdrawalCard groupId={groupId} onClose={() => setRequesting(false)} /></div>}

      {admin && s && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Waiting for approval" value={String(s.awaitingApprovalCount)} hint={formatPaise(s.awaitingApprovalPaise)} />
          <Stat label="Approved, not yet sent" value={String(s.awaitingTransferCount)} hint={`${formatPaise(s.awaitingTransferPaise)} reserved`} />
          <Stat label="Payouts recorded" value={formatPaise(s.payoutsCompletedPaise)} />
          <Stat label="Expenses recorded" value={formatPaise(s.expensesCompletedPaise)} />
        </div>
      )}

      <div className="mb-4 max-w-xs">
        <SelectField label="Filter by status" name="w-status" value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          options={[{ value: "", label: "All" }, ...W_STATUSES.map((x) => ({ value: x, label: W_LABEL[x] }))]} />
      </div>

      {list.isPending && <Spinner />}
      {list.isError && <Alert kind="error">{errorMessage(list.error)}</Alert>}
      {data && <WithdrawalTable items={data.items} />}
      {data && pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-slate-600">Page {page} of {pages}</span>
          <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </>
  );
}
