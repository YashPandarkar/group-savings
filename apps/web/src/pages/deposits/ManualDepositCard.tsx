import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, SelectField, TextField } from "../../components/ui";
import { TextAreaField } from "../../components/TextArea";
import { useToast } from "../../components/Toast";
import { api, errorMessage } from "../../lib/api";
import { apiFieldErrors, zodErrors, type FieldErrors } from "../../lib/forms";
import { newId } from "../../lib/ids";
import { rupeesToPaise } from "../../lib/money";
import { METHOD_OPTIONS } from "../../lib/options";
import { useMembers } from "../../lib/queries";

const schema = z
  .object({
    userId: z.string().min(1, "Choose a member"),
    purpose: z.enum(["MONTHLY_DEPOSIT", "ADDITIONAL_DEPOSIT"]),
    amount: z.string().refine((v) => {
      const p = rupeesToPaise(v);
      return p !== null && p >= 100 && p <= 100_000_000;
    }, "Enter an amount from ₹1 to ₹10,00,000"),
    method: z.enum(["UPI", "CASH", "BANK_TRANSFER", "OTHER"]),
    reference: z.string().trim().refine((v) => v === "" || /^[A-Za-z0-9_-]{6,64}$/.test(v), "6 to 64 letters, numbers, - or _"),
    note: z.string().trim().min(5, "Describe the evidence (at least 5 characters)").max(500),
    url: z.string().trim().refine((v) => v === "" || v.startsWith("https://"), "The link must start with https://"),
    date: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.method !== "CASH" && v.reference === "") {
      ctx.addIssue({ code: "custom", path: ["reference"], message: "Enter the UTR / transaction ID" });
    }
  });

const SERVER_FIELDS: Record<string, string> = {
  amountPaise: "amount", paymentReference: "reference", evidenceNote: "note", evidenceUrl: "url", paidAt: "date", userId: "userId",
};

// President / VP records money that REALLY arrived outside the app. It is a record, not proof of money.
export default function ManualDepositCard({ groupId }: { groupId: string }) {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const members = useMembers();

  const [userId, setUserId] = useState("");
  const [purpose, setPurpose] = useState("MONTHLY_DEPOSIT");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [url, setUrl] = useState("");
  const [date, setDate] = useState("");
  const [requestId, setRequestId] = useState(newId); // kept until the record succeeds, so retries are safe
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Nobody records a deposit into their own account (the server refuses it too).
  const others = (members.data?.members ?? []).filter((m) => m.userId !== me!.user.id);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = schema.safeParse({ userId, purpose, amount, method, reference, note, url, date });
    if (!parsed.success) return setErrors(zodErrors(parsed.error));
    setErrors({});
    const v = parsed.data;

    const body: Record<string, unknown> = {
      userId: v.userId, purpose: v.purpose, amountPaise: rupeesToPaise(v.amount), method: v.method,
      evidenceNote: v.note, clientRequestId: requestId,
    };
    if (v.reference) body.paymentReference = v.reference;
    if (v.url) body.evidenceUrl = v.url;
    if (v.date) body.paidAt = `${v.date}T00:00:00+05:30`;

    setBusy(true);
    try {
      const res = await api<{ replayed: boolean }>(`/api/groups/${groupId}/deposits/manual`, { method: "POST", body });
      toast.success(res.replayed ? "This deposit was already recorded." : "Deposit recorded.");
      setAmount(""); setReference(""); setNote(""); setUrl(""); setDate("");
      setRequestId(newId());
      void qc.invalidateQueries();
    } catch (err) {
      setErrors(apiFieldErrors(err, SERVER_FIELDS));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Record a deposit</h2>
      <p className="mt-1 text-sm text-slate-600">For money that arrived outside the app (UPI to the group account, cash, bank transfer). It's a record, not proof of money: keep the evidence.</p>
      <form onSubmit={onSubmit} className="mt-4 space-y-4" noValidate>
        {formError && <Alert kind="error">{formError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Member" name="md-user" value={userId} onChange={setUserId} error={errors.userId}
            options={[{ value: "", label: "Choose…" }, ...others.map((m) => ({ value: m.userId, label: m.name }))]}
            hint="You can't record your own deposit. The other administrator does."
          />
          <SelectField label="Type" name="md-purpose" value={purpose} onChange={setPurpose}
            options={[{ value: "MONTHLY_DEPOSIT", label: "Monthly contribution (oldest unpaid month)" }, { value: "ADDITIONAL_DEPOSIT", label: "Additional deposit" }]} />
          <TextField label="Amount (₹)" name="md-amount" inputMode="decimal" value={amount} onChange={setAmount} error={errors.amount} />
          <SelectField label="Method" name="md-method" value={method} onChange={setMethod} options={METHOD_OPTIONS} />
          <TextField label={method === "CASH" ? "Reference (optional)" : "UTR / transaction ID"} name="md-ref" value={reference} onChange={setReference} error={errors.reference} />
          <TextField label="Date received (optional)" name="md-date" type="date" value={date} onChange={setDate} error={errors.date} hint="Leave empty for now." />
        </div>
        <TextAreaField label="Evidence note" name="md-note" rows={2} value={note} onChange={setNote} error={errors.note} hint="E.g. “UPI screenshot seen on WhatsApp” or “Cash received at the meeting”." />
        <TextField label="Evidence link (optional)" name="md-url" value={url} onChange={setUrl} error={errors.url} placeholder="https://…" />
        <Button type="submit" loading={busy}>Record deposit</Button>
      </form>
    </Card>
  );
}
