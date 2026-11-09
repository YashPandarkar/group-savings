import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, PageHeader, SelectField, Spinner, TextField } from "../../components/ui";
import { TextAreaField } from "../../components/TextArea";
import { useConfirm } from "../../components/Confirm";
import { useToast } from "../../components/Toast";
import { WithdrawalStatusBadge } from "../../components/WithdrawalParts";
import { api, errorMessage } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { formatPaise } from "../../lib/money";
import { METHOD_OPTIONS } from "../../lib/options";
import { isAdmin } from "../../lib/types";
import type { Withdrawal } from "../../lib/withdrawals";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1 font-medium text-slate-900">{value}</dd>
    </div>
  );
}

export default function WithdrawalDetail() {
  const { withdrawalId } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [panel, setPanel] = useState<null | "reject" | "complete">(null);

  const q = useQuery({
    queryKey: ["withdrawal", withdrawalId],
    queryFn: () => api<{ withdrawal: Withdrawal }>(`/api/withdrawals/${withdrawalId}`),
  });

  const post = useMutation({
    mutationFn: (v: { action: string; body?: unknown }) =>
      api(`/api/withdrawals/${withdrawalId}/${v.action}`, { method: "POST", body: v.body ?? {} }),
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

  if (q.isPending) return <Spinner />;
  if (q.isError) {
    return (
      <>
        <Alert kind="error">{errorMessage(q.error)}</Alert>
        <Link to="/withdrawals" className="mt-4 inline-block text-indigo-600">Back to withdrawals</Link>
      </>
    );
  }

  const w = q.data.withdrawal;
  const admin = isAdmin(me!.membership!.role);
  const isRequester = w.requestedBy?.userId === me!.user.id;
  const isBeneficiary = w.beneficiary?.userId === me!.user.id;
  const open = w.status === "PENDING" || w.status === "APPROVED";

  // Convenience only: the server refuses anything that breaks these rules.
  const canApprove = admin && !isRequester && !isBeneficiary && w.status === "PENDING";
  const canReject = admin && !isRequester && open;
  const canCancel = isRequester && open;
  const canComplete = admin && !isBeneficiary && w.status === "APPROVED";

  async function approve() {
    const ok = await confirm({
      title: "Approve this withdrawal?",
      message: `${formatPaise(w.amountPaise)} will be reserved. No money is sent until a transfer is recorded.`,
      confirmLabel: "Approve",
    });
    if (ok) run("approve", {}, "Withdrawal approved.");
  }
  async function cancel() {
    const ok = await confirm({ title: "Withdraw this request?", message: "The request will be closed and any reserved money released.", confirmLabel: "Withdraw request", danger: true });
    if (ok) run("cancel", {}, "Request withdrawn.");
  }

  return (
    <>
      <Link to="/withdrawals" className="mb-4 inline-block text-sm text-indigo-600">← All withdrawals</Link>
      <PageHeader
        title={`${formatPaise(w.amountPaise)}: ${w.beneficiary ? `payout to ${w.beneficiary.name}` : "group expense"}`}
        subtitle={w.purpose}
        action={<WithdrawalStatusBadge status={w.status} />}
      />

      <div className="space-y-6">
        <Alert kind={w.status === "COMPLETED" ? "success" : w.status === "APPROVED" ? "warning" : "info"}>{w.statusNote}</Alert>
        {w.status === "REJECTED" && w.rejectionReason && <Alert kind="warning">Reason: {w.rejectionReason}</Alert>}

        <Card>
          <h2 className="text-lg font-semibold">Details</h2>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
            <Row label="Requested" value={formatDateTime(w.requestedAt)} />
            {w.requestedBy && <Row label="Requested by" value={w.requestedBy.name} />}
            {w.firstApprovalBy && <Row label="First sign-off" value={w.firstApprovalBy} />}
            {w.secondApprovalBy && <Row label="Second approval" value={`${w.secondApprovalBy}${w.secondApprovedAt ? `, ${formatDateTime(w.secondApprovedAt)}` : ""}`} />}
            {w.completedAt && <Row label="Transfer recorded" value={`${formatDateTime(w.completedAt)}${w.completedBy ? ` by ${w.completedBy}` : ""}`} />}
            {w.method && <Row label="How it was sent" value={w.method.replace("_", " ").toLowerCase()} />}
            {w.paymentReference && <Row label="Transfer reference" value={w.paymentReference} />}
          </dl>
        </Card>

        {(canApprove || canReject || canCancel || canComplete) && (
          <Card>
            <h2 className="text-lg font-semibold">Actions</h2>
            <div className="mt-3 space-y-3">
              {admin && isRequester && w.status === "PENDING" && <Alert kind="info">You made this request, so the other administrator must approve it.</Alert>}
              <div className="flex flex-wrap gap-3">
                {canApprove && <Button loading={post.isPending} onClick={() => void approve()}>Approve</Button>}
                {canComplete && <Button onClick={() => setPanel("complete")}>Record the transfer</Button>}
                {canReject && <Button variant="danger" onClick={() => setPanel("reject")}>Reject</Button>}
                {canCancel && <Button variant="secondary" onClick={() => void cancel()}>Withdraw request</Button>}
              </div>
              {panel === "reject" && <RejectPanel busy={post.isPending} onCancel={() => setPanel(null)} onSubmit={(reason) => run("reject", { reason }, "Withdrawal rejected.")} />}
              {panel === "complete" && <CompletePanel busy={post.isPending} onCancel={() => setPanel(null)} onSubmit={(b) => run("complete", b, "Transfer recorded.")} />}
            </div>
          </Card>
        )}
      </div>
    </>
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
      <TextAreaField label="Reason for rejecting" name="wr-reason" rows={3} value={reason} onChange={setReason} error={error} />
      <div className="flex gap-3">
        <Button type="submit" variant="danger" loading={props.busy}>Reject</Button>
        <Button variant="secondary" onClick={props.onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function CompletePanel(props: { busy: boolean; onCancel: () => void; onSubmit: (body: Record<string, string>) => void }) {
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
      <Alert kind="warning">Only record this after you have <strong>actually sent the money</strong> outside this app. The app does not transfer money, and recording moves the ledger.</Alert>
      <SelectField label="How was it sent?" name="wc-method" value={method} onChange={setMethod} options={METHOD_OPTIONS} />
      {method !== "CASH" && <TextField label="UTR / transaction ID" name="wc-ref" value={reference} onChange={setReference} error={errors.reference} />}
      <TextAreaField label="Evidence note" name="wc-note" rows={2} value={note} onChange={setNote} error={errors.note} hint="E.g. “UTR checked in the bank app”." />
      <div className="flex gap-3">
        <Button type="submit" loading={props.busy}>Record the transfer</Button>
        <Button variant="secondary" onClick={props.onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
