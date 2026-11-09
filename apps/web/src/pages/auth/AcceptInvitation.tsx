import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { Alert, AuthCard, Button, Spinner } from "../../components/ui";
import { useToast } from "../../components/Toast";
import { api, errorMessage } from "../../lib/api";

type Preview = { groupName: string; invitedBy: string; invitedEmail: string; expiresAt: string };

export default function AcceptInvitation() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { status, me, reload } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const here = location.pathname + location.search;

  const preview = useQuery({
    queryKey: ["invitation-preview", token],
    enabled: token.length > 0,
    retry: false,
    queryFn: () => api<Preview>("/api/invitations/preview", { method: "POST", body: { token }, auth: false }),
  });

  const accept = useMutation({
    mutationFn: () => api("/api/invitations/accept", { method: "POST", body: { token } }),
    onSuccess: async () => {
      await reload();
      toast.success("Welcome to the group!");
      navigate("/", { replace: true });
    },
  });

  if (!token) {
    return (
      <AuthCard title="Invitation">
        <Alert kind="error">This invitation link is incomplete. Open it again from your email.</Alert>
      </AuthCard>
    );
  }
  if (preview.isPending) {
    return (
      <AuthCard title="Invitation">
        <div className="flex justify-center"><Spinner /></div>
      </AuthCard>
    );
  }
  if (preview.isError) {
    return (
      <AuthCard title="Invitation">
        <Alert kind="error">{errorMessage(preview.error)}</Alert>
      </AuthCard>
    );
  }

  const p = preview.data;
  const wrongEmail = status === "authenticated" && me !== null && me.user.email !== p.invitedEmail;

  return (
    <AuthCard title={`Join “${p.groupName}”?`} subtitle={`${p.invitedBy} invited ${p.invitedEmail}.`}>
      <div className="space-y-4">
        {status === "loading" && <div className="flex justify-center"><Spinner /></div>}

        {status === "anonymous" && (
          <>
            <p className="text-sm text-slate-700">Log in with <strong>{p.invitedEmail}</strong> to accept.</p>
            <Link to="/login" state={{ from: here }} className="block rounded-lg bg-indigo-600 px-4 py-2 text-center text-sm font-semibold text-white">
              Log in
            </Link>
            <Link to={`/register?email=${encodeURIComponent(p.invitedEmail)}`} className="block text-center text-sm font-medium text-indigo-600">
              I don't have an account yet
            </Link>
            <p className="text-xs text-slate-500">After you register and verify your email, open this invitation link again.</p>
          </>
        )}

        {status === "authenticated" && (
          <>
            {wrongEmail && (
              <Alert kind="warning">
                You're logged in as {me?.user.email}, but this invitation is for {p.invitedEmail}. Log out and log in with the invited account.
              </Alert>
            )}
            {accept.isError && <Alert kind="error">{errorMessage(accept.error)}</Alert>}
            <Button className="w-full" loading={accept.isPending} disabled={wrongEmail} onClick={() => accept.mutate()}>
              Accept invitation
            </Button>
            <p className="text-xs text-slate-500">You can belong to only one group at a time. Accepting cancels your other pending invitations.</p>
          </>
        )}
      </div>
    </AuthCard>
  );
}
