import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { z } from "zod";
import { Alert, AuthCard, Button, TextField } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";

const emailSchema = z.string().trim().min(1, "Enter your email").email("Enter a valid email");

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    setError(undefined);
    setBusy(true);
    try {
      await api("/api/auth/forgot-password", { method: "POST", body: { email: parsed.data.toLowerCase() }, auth: false });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Forgot your password?" footer={<Link to="/login" className="font-medium text-indigo-600">Back to log in</Link>}>
      {done ? (
        <Alert kind="success">If that email is registered, we've sent a reset link. It expires in 1 hour.</Alert>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <TextField label="Email" name="email" type="email" autoComplete="email" inputMode="email" value={email} onChange={setEmail} error={error} />
          <Button type="submit" loading={busy} className="w-full">Send reset link</Button>
        </form>
      )}
    </AuthCard>
  );
}
