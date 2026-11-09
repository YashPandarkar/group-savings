import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { Alert, AuthCard, Button, TextField } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";
import { apiFieldErrors, zodErrors, type FieldErrors } from "../../lib/forms";

// Same rules as the server (the server still checks everything again).
const schema = z
  .object({
    name: z.string().trim().min(2, "Enter your name").max(80),
    email: z.string().trim().min(1, "Enter your email").email("Enter a valid email"),
    password: z
      .string()
      .min(10, "Use at least 10 characters")
      .regex(/[A-Za-z]/, "Include a letter")
      .regex(/[0-9]/, "Include a number"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords don't match", path: ["confirm"] });

export default function Register() {
  const [params] = useSearchParams();
  const [name, setName] = useState("");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = schema.safeParse({ name, email, password, confirm });
    if (!parsed.success) return setErrors(zodErrors(parsed.error));
    setErrors({});
    setBusy(true);
    try {
      await api("/api/auth/register", {
        method: "POST",
        body: { name: parsed.data.name, email: parsed.data.email.toLowerCase(), password: parsed.data.password },
        auth: false,
      });
      setDone(true);
    } catch (err) {
      setErrors(apiFieldErrors(err));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthCard title="Check your email" footer={<Link to="/login" className="font-medium text-indigo-600">Back to log in</Link>}>
        <p className="text-sm text-slate-700">
          If this email can be registered, we've sent a verification link to <strong>{email}</strong>. Open it, verify, then log in.
        </p>
        <div className="mt-4">
          <Alert kind="info">
            Development: emails aren't really sent. The link is printed in the terminal where the API is running.
          </Alert>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      footer={
        <>
          Already registered? <Link to="/login" className="font-medium text-indigo-600">Log in</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {formError && <Alert kind="error">{formError}</Alert>}
        <TextField label="Full name" name="name" autoComplete="name" value={name} onChange={setName} error={errors.name} />
        <TextField label="Email" name="email" type="email" autoComplete="email" inputMode="email" value={email} onChange={setEmail} error={errors.email} hint="Use the address your invitation was sent to, if you have one." />
        <TextField label="Password" name="password" type="password" autoComplete="new-password" value={password} onChange={setPassword} error={errors.password} hint="At least 10 characters, with a letter and a number." />
        <TextField label="Confirm password" name="confirm" type="password" autoComplete="new-password" value={confirm} onChange={setConfirm} error={errors.confirm} />
        <Button type="submit" loading={busy} className="w-full">Create account</Button>
      </form>
    </AuthCard>
  );
}
