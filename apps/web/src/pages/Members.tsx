import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useAuth } from "../auth/AuthContext";
import { Alert, Button, Card, EmptyState, PageHeader, Spinner, TextField } from "../components/ui";
import { Badge } from "../components/Badge";
import { useConfirm } from "../components/Confirm";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";
import { formatDate } from "../lib/format";
import { useGroup } from "../lib/queries";
import { isAdmin, ROLE_LABEL, type Role } from "../lib/types";

type Member = { id: string; userId: string; name: string; email?: string; role: Role; status: string; joinedAt: string };
type Invitation = {
  id: string; email: string; status: "PENDING" | "ACCEPTED" | "CANCELLED" | "EXPIRED";
  invitedBy: string; expiresAt: string; createdAt: string;
};

const ROLE_TONE = { PRESIDENT: "indigo", VICE_PRESIDENT: "green", MEMBER: "slate" } as const;
const INVITE_TONE = { PENDING: "amber", ACCEPTED: "green", CANCELLED: "slate", EXPIRED: "red" } as const;
const emailSchema = z.string().trim().min(1, "Enter an email").email("Enter a valid email");

function LinkButton({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`text-xs font-medium hover:underline ${danger ? "text-red-600" : "text-indigo-600"}`}>
      {children}
    </button>
  );
}

export default function Members() {
  const { me, reload } = useAuth();
  const groupId = me!.membership!.groupId;
  const myRole = me!.membership!.role;
  const myUserId = me!.user.id;
  const president = myRole === "PRESIDENT";

  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const group = useGroup();
  const members = useQuery({
    queryKey: ["members", groupId],
    queryFn: () => api<{ members: Member[] }>(`/api/groups/${groupId}/members`),
  });

  function refresh() {
    for (const key of ["members", "group", "invitations"]) void qc.invalidateQueries({ queryKey: [key, groupId] });
  }

  const changeRole = useMutation({
    mutationFn: (v: { memberId: string; role: Role }) =>
      api(`/api/groups/${groupId}/members/${v.memberId}/role`, { method: "PUT", body: { role: v.role } }),
    onSuccess: async () => {
      toast.success("Role updated.");
      refresh();
      await reload(); // if you handed over the presidency, your own role just changed
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (memberId: string) => api(`/api/groups/${groupId}/members/${memberId}/remove`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Member removed.");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const leave = useMutation({
    mutationFn: () => api(`/api/groups/${groupId}/leave`, { method: "POST" }),
    onSuccess: async () => {
      toast.success("You have left the group.");
      await reload(); // no group any more: the router sends you to the welcome page
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  async function setRole(m: Member, role: Role) {
    const copy =
      role === "PRESIDENT"
        ? { title: `Make ${m.name} the President?`, message: "You will become an ordinary member and lose President powers. This is how the presidency is handed over.", confirmLabel: "Transfer presidency", danger: true }
        : role === "VICE_PRESIDENT"
          ? { title: `Make ${m.name} Vice President?`, message: "The current Vice President, if there is one, becomes an ordinary member.", confirmLabel: "Make Vice President", danger: false }
          : { title: `Remove ${m.name}'s Vice President role?`, message: "They become an ordinary member.", confirmLabel: "Remove role", danger: false };
    if (await confirm(copy)) changeRole.mutate({ memberId: m.id, role });
  }

  async function onRemove(m: Member) {
    const ok = await confirm({
      title: `Remove ${m.name}?`,
      message: "They lose access to the group. Their history stays in the records. This is refused while they have an open loan, unpaid dues or savings still in the fund.",
      confirmLabel: "Remove member",
      danger: true,
    });
    if (ok) remove.mutate(m.id);
  }

  async function onLeave() {
    const ok = await confirm({
      title: "Leave this group?",
      message: "You can leave only with no open loan, no unpaid dues and no savings left in the fund. Your history stays in the group's records.",
      confirmLabel: "Leave group",
      danger: true,
    });
    if (ok) leave.mutate();
  }

  const g = group.data;
  const seats = g?.memberCount !== undefined ? `${g.memberCount} of ${g.maxMembers} seats used` : undefined;

  return (
    <>
      <PageHeader
        title="Members"
        subtitle={seats}
        action={!president ? <Button variant="secondary" loading={leave.isPending} onClick={() => void onLeave()}>Leave group</Button> : undefined}
      />
      {president && (
        <p className="-mt-3 mb-4 text-xs text-slate-500">
          The President can't leave without handing over the presidency: use “Make President” on another member first.
        </p>
      )}

      {members.isPending && <Spinner />}
      {members.isError && <Alert kind="error">{errorMessage(members.error)}</Alert>}
      {members.data && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Joined</th>
                {president && <th className="px-4 py-3">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {members.data.members.map((m) => {
                const canOpen = isAdmin(myRole) || m.userId === myUserId;
                const isMe = m.userId === myUserId;
                return (
                  <tr key={m.id}>
                    <td className="px-4 py-3">
                      {canOpen ? (
                        <Link to={`/members/${m.id}`} className="font-medium text-indigo-600">{m.name}</Link>
                      ) : (
                        <span className="font-medium text-slate-900">{m.name}</span>
                      )}
                      {isMe && <span className="ml-2 text-xs text-slate-500">(you)</span>}
                      {m.email && <p className="text-xs text-slate-500">{m.email}</p>}
                    </td>
                    <td className="px-4 py-3"><Badge tone={ROLE_TONE[m.role]}>{ROLE_LABEL[m.role]}</Badge></td>
                    <td className="px-4 py-3">{formatDate(m.joinedAt)}</td>
                    {president && (
                      <td className="px-4 py-3">
                        {!isMe && (
                          <div className="flex flex-wrap gap-x-4 gap-y-1">
                            {m.role === "VICE_PRESIDENT" ? (
                              <LinkButton onClick={() => void setRole(m, "MEMBER")}>Remove VP role</LinkButton>
                            ) : (
                              <LinkButton onClick={() => void setRole(m, "VICE_PRESIDENT")}>Make Vice President</LinkButton>
                            )}
                            <LinkButton onClick={() => void setRole(m, "PRESIDENT")}>Make President</LinkButton>
                            <LinkButton danger onClick={() => void onRemove(m)}>Remove</LinkButton>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {president && <Invitations groupId={groupId} onChanged={refresh} />}
    </>
  );
}

function Invitations({ groupId, onChanged }: { groupId: string; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();

  const list = useQuery({
    queryKey: ["invitations", groupId],
    queryFn: () => api<{ invitations: Invitation[] }>(`/api/groups/${groupId}/invitations`),
  });

  const invite = useMutation({
    mutationFn: (e: string) => api(`/api/groups/${groupId}/invitations`, { method: "POST", body: { email: e } }),
    onSuccess: () => {
      toast.success("Invitation created.");
      setEmail("");
      onChanged();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api(`/api/groups/${groupId}/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Invitation cancelled.");
      onChanged();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    setError(undefined);
    invite.mutate(parsed.data.toLowerCase());
  }

  async function onCancel(inv: Invitation) {
    if (await confirm({ title: "Cancel this invitation?", message: `${inv.email} will no longer be able to use the link.`, confirmLabel: "Cancel invitation", danger: true })) {
      cancel.mutate(inv.id);
    }
  }

  return (
    <div className="mt-10">
      <h2 className="mb-3 text-lg font-semibold">Invitations</h2>
      <Card>
        <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
          <div className="flex-1">
            <TextField label="Invite by email" name="invite-email" type="email" inputMode="email" value={email} onChange={setEmail} error={error} hint="They must register and verify this exact address. Each invitation expires in 7 days." />
          </div>
          <Button type="submit" loading={invite.isPending} className="sm:mt-6">Send invitation</Button>
        </form>
        <div className="mt-4">
          <Alert kind="info">Development: emails aren't really sent. The invitation link is printed in the terminal where the API is running.</Alert>
        </div>
      </Card>

      <div className="mt-4">
        {list.isPending && <Spinner />}
        {list.isError && <Alert kind="error">{errorMessage(list.error)}</Alert>}
        {list.data && list.data.invitations.length === 0 && <EmptyState title="No invitations yet" />}
        {list.data && list.data.invitations.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Invited by</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.invitations.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-4 py-3">{inv.email}</td>
                    <td className="px-4 py-3"><Badge tone={INVITE_TONE[inv.status]}>{inv.status.charAt(0) + inv.status.slice(1).toLowerCase()}</Badge></td>
                    <td className="px-4 py-3">{inv.invitedBy}</td>
                    <td className="px-4 py-3">{formatDate(inv.expiresAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {inv.status === "PENDING" && <LinkButton danger onClick={() => void onCancel(inv)}>Cancel</LinkButton>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
