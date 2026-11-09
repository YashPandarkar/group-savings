import { useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, PageHeader, SelectField, Spinner } from "../../components/ui";
import { LoanTable } from "../../components/LoanTable";
import { api, errorMessage } from "../../lib/api";
import { LOAN_STATUSES, LOAN_STATUS_LABEL, type LoanPage } from "../../lib/loans";
import { formatPaise } from "../../lib/money";
import { isAdmin } from "../../lib/types";

type Report = {
  summary: {
    loansDisbursedPaise: number; repaidPaise: number; principalRepaidPaise: number; interestEarnedPaise: number;
    outstandingPrincipalPaise: number; outstandingTotalPaise: number; overduePaise: number; activeLoans: number; overdueLoans: number;
  };
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

export default function Loans() {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const admin = isAdmin(me!.membership!.role);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const list = useQuery({
    queryKey: ["loans", groupId, status, page],
    queryFn: () => api<LoanPage>(`/api/groups/${groupId}/loans?page=${page}&pageSize=15${status ? `&status=${status}` : ""}`),
    placeholderData: keepPreviousData,
  });
  const report = useQuery({
    queryKey: ["loans-outstanding", groupId],
    enabled: admin,
    queryFn: () => api<Report>(`/api/groups/${groupId}/loans/outstanding`),
  });

  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const s = report.data?.summary;

  return (
    <>
      <PageHeader
        title="Loans"
        subtitle={admin ? "All loans in the group." : "Your loans."}
        action={<Link to="/loans/apply" className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">Apply for a loan</Link>}
      />

      {admin && s && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Lent out (ever)" value={formatPaise(s.loansDisbursedPaise)} />
          <Stat label="Outstanding" value={formatPaise(s.outstandingTotalPaise)} hint={`${s.activeLoans} live loans`} />
          <Stat label="Overdue" value={formatPaise(s.overduePaise)} hint={`${s.overdueLoans} loans overdue`} />
          <Stat label="Interest earned" value={formatPaise(s.interestEarnedPaise)} hint={`${formatPaise(s.repaidPaise)} repaid in total`} />
        </div>
      )}

      <div className="mb-4 max-w-xs">
        <SelectField
          label="Filter by status" name="loan-status" value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          options={[{ value: "", label: "All" }, ...LOAN_STATUSES.map((x) => ({ value: x, label: LOAN_STATUS_LABEL[x] }))]}
        />
      </div>

      {list.isPending && <Spinner />}
      {list.isError && <Alert kind="error">{errorMessage(list.error)}</Alert>}
      {data && <LoanTable loans={data.items} showBorrower={admin} />}
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
