import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, Spinner } from "../../components/ui";
import { Badge } from "../../components/Badge";
import { api, errorMessage } from "../../lib/api";
import { formatDateTime } from "../../lib/format";

type Integrity = {
  ok: boolean; checkedAt: string; fundBalancePaise: number;
  checks: { name: string; ok: boolean; failures: number; sampleIds: string[] }[];
};

const DESCRIPTION: Record<string, string> = {
  JOURNALS_BALANCED: "Every record's debits equal its credits",
  NO_EMPTY_JOURNALS: "No record is missing its ledger lines",
  LEDGER_NETS_TO_ZERO: "The whole ledger nets to zero",
  FUND_NOT_NEGATIVE: "The group fund isn't negative",
  MEMBER_SAVINGS_NOT_NEGATIVE: "No member's savings are negative",
  CONTRIBUTIONS_MATCH_LEDGER: "Each contribution's paid amount matches the ledger",
};

export default function IntegrityTab() {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const q = useQuery({
    queryKey: ["integrity", groupId],
    queryFn: () => api<Integrity>(`/api/groups/${groupId}/reports/integrity`),
    staleTime: 0,
  });

  return (
    <div className="space-y-6">
      <Alert kind="info">
        This re-checks the group's records against each other. Passing means the records are <strong>consistent with themselves</strong>. It cannot prove they match your bank: compare the fund balance with the bank statement regularly.
      </Alert>
      <Button variant="secondary" loading={q.isFetching} onClick={() => void q.refetch()}>Run the check again</Button>

      {q.isPending && <Spinner />}
      {q.isError && <Alert kind="error">{errorMessage(q.error)}</Alert>}
      {q.data && (
        <>
          <Alert kind={q.data.ok ? "success" : "error"}>
            {q.data.ok ? "All checks passed." : "Some checks failed. Don't ignore this: look into the records below."} Checked {formatDateTime(q.data.checkedAt)}.
          </Alert>
          <Card>
            <ul className="divide-y divide-slate-100">
              {q.data.checks.map((c) => (
                <li key={c.name} className="flex items-start justify-between gap-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{DESCRIPTION[c.name] ?? c.name}</p>
                    {!c.ok && c.sampleIds.length > 0 && <p className="mt-1 break-all text-xs text-slate-500">Examples: {c.sampleIds.join(", ")}</p>}
                  </div>
                  {c.ok ? <Badge tone="green">Passed</Badge> : <Badge tone="red">{c.failures} failed</Badge>}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
