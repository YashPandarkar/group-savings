import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { Alert, Spinner } from "../components/ui";
import { LoanTable } from "../components/LoanTable";
import { api, errorMessage } from "../lib/api";
import type { LoanPage } from "../lib/loans";

// Administrators only (the loans list shows everyone's loans to them).
export default function MemberLoans({ userId }: { userId: string }) {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const q = useQuery({
    queryKey: ["loans", groupId, "all"],
    queryFn: () => api<LoanPage>(`/api/groups/${groupId}/loans?pageSize=100`),
  });
  return (
    <div className="mt-8">
      <h2 className="mb-3 text-lg font-semibold">Loan history</h2>
      {q.isPending && <Spinner />}
      {q.isError && <Alert kind="error">{errorMessage(q.error)}</Alert>}
      {q.data && <LoanTable loans={q.data.items.filter((l) => l.borrower.userId === userId)} showBorrower={false} />}
    </div>
  );
}
