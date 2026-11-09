import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, SelectField, TextField } from "../../components/ui";
import { TextAreaField } from "../../components/TextArea";
import { useConfirm } from "../../components/Confirm";
import { useToast } from "../../components/Toast";
import { errorMessage } from "../../lib/api";
import { api } from "../../lib/api";
import type { Loan } from "../../lib/loans";
import { formatPaise } from "../../lib/money";
import { METHOD_OPTIONS } from "../../lib/options";

type Props = {
  loan: Loan;
  canReview: boolean; // an administrator who is not the borrower
  canDecide: boolean; // may approve, reject and disburse THIS loan
  isBorrower: boolean;
  deciderLabel: string; // "the President" or "the Vice President"
};

// Every button here is a convenience. The server decides who may do what and refuses everyone else.
export default function LoanActions({ loan, canReview, canDecide, isBorrower, deciderLabel }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [panel, setPanel] = useState<null | "reject" | "disburse">(null);

  const post = useMutation({
    mutationFn: (v: { action: string; body?: unknown }) =>
      api(`/api/loans/${loan.id}/${v.action}`, { method: "POST", body: v.body ?? {} }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  function run(action: string, body: unknown, message: string) {
    post.mutate({ action, body }, {
      onSuccess: () => {
        toast.success(message);
        setPanel(null);
        void qc.invalidateQueries();
      },
    });
  }

  const status = loan.status;
  const open = status === "PENDING" || status === "UNDER_REVIEW";
  const showAny = (isBorrower && (open || status === "APPROVED")) || (canReview && (open || status === "APPROVED"));
  if (!showAny) return null;

  async function approve() {
    const ok = await confirm({
      title: "Approve this loan?",
      message: `${loan.borrower.name} will repay ${formatPaise(loan.totalRepayablePaise ?? loan.principalPaise)} in ${loan.installmentCount} installments. ${loan.policy} The terms are then fixed.`,
      confirmLabel: "Approve",
    });
    if (ok) run("approve", {}, "Loan approved.");
  }
  async function withdraw() {
    const ok = await confirm({ title: "Withdraw your application?", message: "The application will be closed. You can apply again later.", confirmLabel: "Withdraw", danger: true });
    if (ok) run("cancel", {}, "Application withdrawn.");
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Actions</h2>
      <div className="mt-3 space-y-3">
        {canReview && !canDecide && (
          <Alert kind="info">Only {deciderLabel} can approve, reject or disburse this loan. You can mark it as under review.</Alert>
        )}
        <div className="flex flex-wrap gap-3">
          {canReview && status === "PENDING" && (
            <Button variant="secondary" loading={post.isPending} onClick={() => run("review", {}, "Marked as under review.")}>Mark under review</Button>
          )}
          {canDecide && open && <Button loading={post.isPending} onClick={() => void approve()}>Approve</Button>}
          {canDecide && status === "APPROVED" && <Button onClick={() => setPanel("disburse")}>Record disbursement</Button>}
          {canDecide && (open || status === "APPROVED") && <Button variant="danger" onClick={() => setPanel("reject")}>Reject</Button>}
          {isBorrower && (open || status === "APPROVED") && <Button variant="secondary" onClick={() => void withdraw()}>Withdraw application</Button>}
        </div>

        {panel === "reject" && (
          <RejectPanel busy={post.isPending} onCancel={() => setPanel(null)} onSubmit={(reason) => run("reject", { reason }, "Loan rejected.")} />
        )}
        {panel === "disburse" && (
          <DisbursePanel busy={post.isPending} onCancel={() => setPanel(null)} onSubmit={(b) => run("disburse", b, "Disbursement recorded.")} />
        )}
      </div>
    </Card>
  );
}

function RejectPanel(props: { busy: boolean; onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 10) return setError("Explain the reason (at least 10 characters)");
    props.onSubmit(reason.trim());
  }
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-slate-200 p-4" noValidate>
      <TextAreaField label="Reason for rejecting" name="reject-reason" rows={3} value={reason} onChange={setReason} error={error} />
      <div className="flex gap-3">
        <Button type="submit" variant="danger" loading={props.busy}>Reject loan</Button>
        <Button variant="secondary" onClick={props.onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function DisbursePanel(props: { busy: boolean; onCancel: () => void; onSubmit: (body: Record<string, string>) => void }) {
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (method !== "CASH" && !/^[A-Za-z0-9_-]{6,64}$/.test(reference.trim())) next.reference = "Enter the transfer's UTR / transaction ID (6 to 64 letters or numbers)";
    if (note.trim().length < 5) next.note = "Describe the evidence (at least 5 characters)";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    props.onSubmit({ method, note: note.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}) });
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-slate-200 p-4" noValidate>
      <Alert kind="warning">This records that you <strong>have already sent</strong> the money outside this app. The app does not transfer money.</Alert>
      <SelectField label="How was it sent?" name="dis-method" value={method} onChange={setMethod} options={METHOD_OPTIONS} />
      {method !== "CASH" && <TextField label="UTR / transaction ID" name="dis-ref" value={reference} onChange={setReference} error={errors.reference} />}
      <TextAreaField label="Evidence note" name="dis-note" rows={2} value={note} onChange={setNote} error={errors.note} hint="E.g. “UTR checked in the bank app”." />
      <div className="flex gap-3">
        <Button type="submit" loading={props.busy}>Record disbursement</Button>
        <Button variant="secondary" onClick={props.onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
