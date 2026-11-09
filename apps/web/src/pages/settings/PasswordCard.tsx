import { useState, type FormEvent } from "react";
import { z } from "zod";
import { Alert, Button, Card, TextField } from "../../components/ui";
import { useToast } from "../../components/Toast";
import { ApiError, api, errorMessage } from "../../lib/api";
import { apiFieldErrors, zodErrors, type FieldErrors } from "../../lib/forms";

const schema = z
  .object({
    current: z.string().min(1, "Enter your current password"),
    next: z
      .string()
      .min(10, "Use at least 10 characters")
      .regex(/[A-Za-z]/, "Include a letter")
      .regex(/[0-9]/, "Include a number"),
    confirm: z.string(),
  })
  .refine((v) => v.next === v.confirm, { message: "Passwords don't match", path: ["confirm"] });

export default function PasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = schema.safeParse({ current, next, confirm });
    if (!parsed.success) return setErrors(zodErrors(parsed.error));
    setErrors({});
    setBusy(true);
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword: parsed.data.current, newPassword: parsed.data.next },
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password changed. Your other devices were logged out.");
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_CURRENT_PASSWORD") {
        setErrors({ current: err.message });
      } else {
        setErrors(apiFieldErrors(err, { currentPassword: "current", newPassword: "next" }));
        setFormError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Change password</h2>
      <form onSubmit={onSubmit} className="mt-4 max-w-md space-y-4" noValidate>
        {formError && <Alert kind="error">{formError}</Alert>}
        <TextField label="Current password" name="current" type="password" autoComplete="current-password" value={current} onChange={setCurrent} error={errors.current} />
        <TextField label="New password" name="next" type="password" autoComplete="new-password" value={next} onChange={setNext} error={errors.next} hint="At least 10 characters, with a letter and a number." />
        <TextField label="Confirm new password" name="confirm-new" type="password" autoComplete="new-password" value={confirm} onChange={setConfirm} error={errors.confirm} />
        <Button type="submit" loading={busy}>Change password</Button>
        <p className="text-xs text-slate-500">Changing your password logs you out on all your other devices.</p>
      </form>
    </Card>
  );
}
