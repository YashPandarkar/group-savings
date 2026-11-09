import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Alert, AuthCard, Button } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";

// The token is spent only when the person CLICKS the button. Some email scanners open links
// automatically, and that must not use up the one-time link.
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    setState("busy");
    setError(null);
    try {
      await api("/api/auth/verify-email", { method: "POST", body: { token }, auth: false });
      setState("done");
    } catch (err) {
      setError(errorMessage(err));
      setState("idle");
    }
  }

  return (
    <AuthCard title="Verify your email">
      {!token && <Alert kind="error">This link is incomplete. Open the link from your email again.</Alert>}
      {token && state !== "done" && (
        <div className="space-y-4">
          {error && <Alert kind="error">{error} You can request a new link from the log in page.</Alert>}
          <p className="text-sm text-slate-700">Confirm that this is your email address.</p>
          <Button loading={state === "busy"} onClick={() => void verify()} className="w-full">Verify my email</Button>
        </div>
      )}
      {state === "done" && (
        <div className="space-y-4">
          <Alert kind="success">Email verified.</Alert>
          <Link to="/login" className="block text-center font-medium text-indigo-600">Continue to log in</Link>
        </div>
      )}
    </AuthCard>
  );
}
