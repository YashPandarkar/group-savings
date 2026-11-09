import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { z } from "zod";
import { useAuth } from "../../auth/AuthContext";
import { Alert, AuthCard, Button, TextField } from "../../components/ui";
import { useToast } from "../../components/Toast";
import { ApiError, api, errorMessage } from "../../lib/api";
import { zodErrors, type FieldErrors } from "../../lib/forms";

const schema = z.object({
  email: z.string().trim().min(1, "Enter your email").email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});

export default function Login() {
  const { status, login } = useAuth();
  const location = useLocation();
  const toast = useToast();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [busy, setBusy] = useState(false);

  if (status === "authenticated") return <Navigate to={from} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setNeedsVerification(false);
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) return setErrors(zodErrors(parsed.error));
    setErrors({});
    setBusy(true);
    try {
      await login(parsed.data.email.toLowerCase(), parsed.data.password);
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_NOT_VERIFIED") setNeedsVerification(true);
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    try {
      await api("/api/auth/resend-verification", { method: "POST", body: { email: email.trim().toLowerCase() }, auth: false });
      toast.success("If that account needs verification, we've sent a new link.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <AuthCard
      title="Log in"
      subtitle="Welcome back."
      footer={
        <>
          New here? <Link to="/register" className="font-medium text-indigo-600">Create an account</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {formError && <Alert kind="error">{formError}</Alert>}
        {needsVerification && (
          <Button variant="secondary" onClick={() => void resend()}>
            Send me a new verification link
          </Button>
        )}
        <TextField label="Email" name="email" type="email" autoComplete="email" inputMode="email" value={email} onChange={setEmail} error={errors.email} />
        <TextField label="Password" name="password" type="password" autoComplete="current-password" value={password} onChange={setPassword} error={errors.password} />
        <Button type="submit" loading={busy} className="w-full">Log in</Button>
        <p className="text-center text-sm">
          <Link to="/forgot-password" className="text-indigo-600">Forgot your password?</Link>
        </p>
      </form>
    </AuthCard>
  );
}
