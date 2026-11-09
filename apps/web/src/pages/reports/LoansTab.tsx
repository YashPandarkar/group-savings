import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Card, Spinner } from "../../components/ui";
import { LoanTable } from "../../components/LoanTable";
import { api, errorMessage } from "../../lib/api";
import type { Loan } from "../../lib/loans";
import { formatPaise } from "../../lib/money";

type Report = {
  summary: {
    loansDisbursedPaise: number; repaidPaise: number; principalRepaidPaise: number; interestEarnedPaise: number;
    outstandingPrincipalPaise: number; outstandingTotalPaise: number; overduePaise: number; activeLoans: number; overdueLoans: number;
  };
  items: Loan[];
};

export default function LoansTab() {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const q = useQuery({
    queryKey: ["loans-outstanding", groupId],
    queryFn: () => api<Report>(`/api/groups/${groupId}/loans/outstanding`),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert kind="error">{errorMessage(q.error)}</Alert>;
  const s = q.data.summary;

  const cards: [string, string, string?][] = [
    ["Lent out (ever)", formatPaise(s.loansDisbursedPaise)],
    ["Repaid so far", formatPaise(s.repaidPaise), `${formatPaise(s.principalRepaidPaise)} principal`],
    ["Interest earned", formatPaise(s.interestEarnedPaise)],
    ["Outstanding principal", formatPaise(s.outstandingPrincipalPaise)],
    ["Outstanding in total", formatPaise(s.outstandingTotalPaise), `${s.activeLoans} live loans`],
    ["Overdue", formatPaise(s.overduePaise), `${s.overdueLoans} loans overdue`],
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map(([label, value, hint]) => (
          <Card key={label}>
            <p className="text-sm text-slate-500">{label}</p>
            <p className="mt-1 text-xl font-bold">{value}</p>
            {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
          </Card>
        ))}
      </div>
      <div>
        <h2 className="mb-3 text-lg font-semibold">Outstanding loans</h2>
        <LoanTable loans={q.data.items} showBorrower />
      </div>
    </div>
  );
}
