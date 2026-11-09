import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, SelectField, TextField } from "../../components/ui";
import { TextAreaField } from "../../components/TextArea";
import { useToast } from "../../components/Toast";
import { api, errorMessage } from "../../lib/api";
import { apiFieldErrors, type FieldErrors } from "../../lib/forms";
import { newId } from "../../lib/ids";
import type { Loan } from "../../lib/loans";
import { formatPaise, paiseToInput, rupeesToPaise } from "../../lib/money";
import { METHOD_OPTIONS } from "../../lib/options";

// President / VP records a repayment that arrived outside the app. A record, not proof of money.
export default function RecordRepaymentCard({ loan }: { loan: Loan }) {
  const toast = useToast();
  const qc = useQueryClient();
  const next = loan.nextDue?.remainingPaise ?? 0;
  const [amount, setAmount] = useState(next > 0 ? paiseToInput(next) : "");
  const [method, setMethod] = useState("CASH");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState(newId); // kept until success: retries can't double-record
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const paise = rupeesToPaise(amount);
    const next: FieldErrors = {};
    if (paise === null || paise < 100) next.amount = "Enter an amount of at least ₹1";
    if (method !== "CASH" && !/^[A-Za-z0-9_-]{6,64}$/.test(reference.trim())) next.reference = "Enter the UTR / transaction ID (6 to 64 letters or numbers)";
    if (note.trim().length < 5) next.note = "Describe the evidence (at least 5 characters)";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const body: Record<string, unknown> = { amountPaise: paise, method, evidenceNote: note.trim(), clientRequestId: requestId };
    if (reference.trim()) body.paymentReference = reference.trim();

    setBusy(true);
    try {
      const res = await api<{ replayed: boolean }>(`/api/loans/${loan.id}/repayments`, { method: "POST", body });
      toast.success(res.replayed ? "This repayment was already recorded." : "Repayment recorded.");
      setReference(""); setNote("");
      setRequestId(newId());
      void qc.invalidateQueries();
    } catch (err) {
      setErrors(apiFieldErrors(err, { amountPaise: "amount", paymentReference: "reference", evidenceNote: "note" }));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Record a repayment</h2>
      <p className="mt-1 text-sm text-slate-600">Outstanding: {formatPaise(loan.outstandingPaise ?? 0)}. You can't record repayments on your own loan.</p>
      <form onSubmit={onSubmit} className="mt-4 max-w-md space-y-4" noValidate>
        {formError && <Alert kind="error">{formError}</Alert>}
        <TextField label="Amount (₹)" name="rr-amount" inputMode="decimal" value={amount} onChange={setAmount} error={errors.amount} />
        <SelectField label="Method" name="rr-method" value={method} onChange={setMethod} options={METHOD_OPTIONS} />
        {method !== "CASH" && <TextField label="UTR / transaction ID" name="rr-ref" value={reference} onChange={setReference} error={errors.reference} />}
        <TextAreaField label="Evidence note" name="rr-note" rows={2} value={note} onChange={setNote} error={errors.note} />
        <Button type="submit" loading={busy}>Record repayment</Button>
      </form>
    </Card>
  );
}
