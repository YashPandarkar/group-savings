import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { Alert, AuthCard, Button, TextField } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";
import { apiFieldErrors, zodErrors, type FieldErrors } from "../../lib/forms";

const schema = z
  .object({
    password: z
      .string()
      .min(10, "Use at least 10 characters")
      .regex(/[A-Za-z]/, "Include a letter")
      .regex(/[0-9]/, "Include a number"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords don't match", path: ["confirm"] });

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = schema.safeParse({ password, confirm });
    if (!parsed.success) return setErrors(zodErrors(parsed.error));
    setErrors({});
    setBusy(true);
    try {
      await api("/api/auth/reset-password", { method: "POST", body: { token, password: parsed.data.password }, auth: false });
      setDone(true);
    } catch (err) {
      setErrors(apiFieldErrors(err));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Choose a new password">
      {!token && <Alert kind="error">This link is incomplete. Open the link from your email again.</Alert>}
      {token && done && (
        <div className="space-y-4">
          <Alert kind="success">Password updated. You've been logged out everywhere.</Alert>
          <Link to="/login" className="block text-center font-medium text-indigo-600">Log in</Link>
        </div>
      )}
      {token && !done && (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError && <Alert kind="error">{formError}</Alert>}
          <TextField label="New password" name="password" type="password" autoComplete="new-password" value={password} onChange={setPassword} error={errors.password} hint="At least 10 characters, with a letter and a number." />
          <TextField label="Confirm new password" name="confirm" type="password" autoComplete="new-password" value={confirm} onChange={setConfirm} error={errors.confirm} />
          <Button type="submit" loading={busy} className="w-full">Update password</Button>
        </form>
      )}
    </AuthCard>
  );
}
