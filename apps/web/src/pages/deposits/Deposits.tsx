import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Card, PageHeader, Spinner } from "../../components/ui";
import type { Contribution } from "../../components/ContributionTable";
import { api, errorMessage } from "../../lib/api";
import { useGroup } from "../../lib/queries";
import { isAdmin } from "../../lib/types";
import CollectionCard from "./CollectionCard";
import DepositHistory from "./DepositHistory";
import ManualDepositCard from "./ManualDepositCard";
import PayCard from "./PayCard";

export default function Deposits() {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const admin = isAdmin(me!.membership!.role);
  const group = useGroup();

  const mine = useQuery({
    queryKey: ["my-contributions", groupId],
    queryFn: () => api<{ items: Contribution[] }>(`/api/groups/${groupId}/contributions/me`),
  });

  // The oldest unpaid month (the list arrives newest first).
  const due = mine.data ? [...mine.data.items].reverse().find((c) => c.status === "PENDING" || c.status === "PARTIAL") : undefined;
  const p = group.data?.payment;

  return (
    <>
      <PageHeader title="Deposits" subtitle="Pay your contributions and see every deposit." />
      <div className="space-y-8">
        {mine.isPending && <Spinner />}
        {mine.isError && <Alert kind="error">{errorMessage(mine.error)}</Alert>}
        {mine.data && <PayCard key={due?.id ?? "none"} groupId={groupId} due={due} />}

        {p && (p.accountHolder || p.accountNumber || p.upiId) && (
          <Card>
            <h2 className="text-lg font-semibold">Or pay the group directly</h2>
            <p className="mt-1 text-sm text-slate-600">If you send money straight to the group's account, an administrator must record it before it counts here.</p>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              {p.accountHolder && <div><dt className="text-slate-500">Account holder</dt><dd className="font-medium">{p.accountHolder}</dd></div>}
              {p.accountNumber && <div><dt className="text-slate-500">Account number</dt><dd className="font-medium">{p.accountNumber}</dd></div>}
              {p.ifsc && <div><dt className="text-slate-500">IFSC</dt><dd className="font-medium">{p.ifsc}</dd></div>}
              {p.upiId && <div><dt className="text-slate-500">UPI ID</dt><dd className="font-medium">{p.upiId}</dd></div>}
            </dl>
          </Card>
        )}

        {admin && <CollectionCard groupId={groupId} />}
        {admin && <ManualDepositCard groupId={groupId} />}
        <DepositHistory groupId={groupId} admin={admin} />
      </div>
    </>
  );
}
