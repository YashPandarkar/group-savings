import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { Alert, Card, PageHeader, Spinner } from "../components/ui";
import { Badge } from "../components/Badge";
import { ContributionTable, type Contribution } from "../components/ContributionTable";
import { api, errorMessage } from "../lib/api";
import { formatDate } from "../lib/format";
import { isAdmin, ROLE_LABEL, type Role } from "../lib/types";

type MemberDetailData = {
  id: string; userId: string; name: string; email?: string; role: Role; status: string;
  joinedAt: string; leftAt: string | null;
};

export default function MemberDetail() {
  const { memberId } = useParams();
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const admin = isAdmin(me!.membership!.role);

  const member = useQuery({
    queryKey: ["member", groupId, memberId],
    queryFn: () => api<{ member: MemberDetailData }>(`/api/groups/${groupId}/members/${memberId}`),
  });

  // Administrators read anyone's history; a member can only open their own (the server enforces it).
  const history = useQuery({
    queryKey: ["member-contributions", groupId, memberId, admin],
    enabled: member.isSuccess,
    queryFn: () =>
      api<{ items: Contribution[] }>(
        admin ? `/api/groups/${groupId}/contributions/${memberId}` : `/api/groups/${groupId}/contributions/me`
      ),
  });

  if (member.isPending) return <Spinner />;
  if (member.isError) {
    return (
      <>
        <Alert kind="error">{errorMessage(member.error)}</Alert>
        <Link to="/members" className="mt-4 inline-block text-indigo-600">Back to members</Link>
      </>
    );
  }

  const m = member.data.member;
  return (
    <>
      <Link to="/members" className="mb-4 inline-block text-sm text-indigo-600">← All members</Link>
      <PageHeader title={m.name} subtitle={m.email} />

      <Card className="mb-8">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-slate-500">Role</dt><dd className="mt-1"><Badge tone="indigo">{ROLE_LABEL[m.role]}</Badge></dd></div>
          <div><dt className="text-slate-500">Status</dt><dd className="mt-1 font-medium">{m.status.charAt(0) + m.status.slice(1).toLowerCase()}</dd></div>
          <div><dt className="text-slate-500">{m.leftAt ? "Joined / left" : "Joined"}</dt><dd className="mt-1 font-medium">{formatDate(m.joinedAt)}{m.leftAt ? ` / ${formatDate(m.leftAt)}` : ""}</dd></div>
        </dl>
      </Card>

      <h2 className="mb-3 text-lg font-semibold">Contribution history</h2>
      {history.isPending && <Spinner />}
      {history.isError && <Alert kind="error">{errorMessage(history.error)}</Alert>}
      {history.data && <ContributionTable items={history.data.items} />}
      <p className="mt-6 text-xs text-slate-500">Loan history for this member is added with the Loans pages in Part 3.</p>
    </>
  );
}
