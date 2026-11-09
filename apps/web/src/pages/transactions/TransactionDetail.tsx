import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, PageHeader, Spinner } from "../../components/ui";
import { TextAreaField } from "../../components/TextArea";
import { AmountCell } from "../../components/AmountCell";
import { Badge } from "../../components/Badge";
import { useConfirm } from "../../components/Confirm";
import { useToast } from "../../components/Toast";
import { api, errorMessage } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { ACCOUNT_LABEL, TX_LABEL, TX_STATUS_LABEL, type Tx } from "../../lib/ledgerLabels";
import { formatPaise } from "../../lib/money";

type Line = { account: string; memberName: string | null; direction: "DEBIT" | "CREDIT"; amountPaise: number };
type Detail = { transaction: Tx; lines: Line[] };

const REVERSIBLE = ["MONTHLY_DEPOSIT", "ADDITIONAL_DEPOSIT"];

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1 font-medium text-slate-900">{value}</dd>
    </div>
  );
}

export default function TransactionDetail() {
  const { transactionId } = useParams();
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const president = me!.membership!.role === "PRESIDENT";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>();

  const q = useQuery({
    queryKey: ["transaction", groupId, transactionId],
    queryFn: () => api<Detail>(`/api/groups/${groupId}/transactions/${transactionId}`),
  });

  const reverse = useMutation({
    mutationFn: (r: string) =>
      api<{ originalId: string; reversalId: string }>(`/api/groups/${groupId}/transactions/${transactionId}/reverse`, { method: "POST", body: { reason: r } }),
    onSuccess: (res) => {
      toast.success("Deposit reversed.");
      void qc.invalidateQueries();
      navigate(`/transactions/${res.reversalId}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isPending) return <Spinner />;
  if (q.isError) {
    return (
      <>
        <Alert kind="error">{errorMessage(q.error)}</Alert>
        <Link to="/transactions" className="mt-4 inline-block text-indigo-600">Back to transactions</Link>
      </>
    );
  }

  const { transaction: t, lines } = q.data;
  const canReverse = president && t.status === "POSTED" && REVERSIBLE.includes(t.type);

  async function onReverse(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 10) return setReasonError("Explain the reason (at least 10 characters)");
    setReasonError(undefined);
    const ok = await confirm({
      title: "Reverse this deposit?",
      message: "A new reversal record is added and the member's contribution is re-opened. The original record is kept. This can't be undone.",
      confirmLabel: "Reverse deposit",
      danger: true,
    });
    if (ok) reverse.mutate(reason.trim());
  }

  return (
    <>
      <Link to="/transactions" className="mb-4 inline-block text-sm text-indigo-600">← All transactions</Link>
      <PageHeader
        title={TX_LABEL[t.type] ?? t.type}
        subtitle={t.description}
        action={<Badge tone={t.status === "POSTED" ? "green" : t.status === "REVERSED" ? "amber" : "slate"}>{TX_STATUS_LABEL[t.status]}</Badge>}
      />

      <div className="space-y-6">
        {t.status === "REVERSED" && t.reversedById && (
          <Alert kind="warning">This record was reversed. <Link to={`/transactions/${t.reversedById}`} className="font-medium underline">See the reversal</Link>.</Alert>
        )}
        {t.status === "REVERSAL" && t.reversalOfId && (
          <Alert kind="info">This reverses an earlier record. <Link to={`/transactions/${t.reversalOfId}`} className="font-medium underline">See the original</Link>.</Alert>
        )}

        <Card>
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <Row label="Transaction ID" value={t.id} />
            <Row label="Date" value={formatDateTime(t.occurredAt)} />
            <div><dt className="text-slate-500">Amount</dt><dd className="mt-1"><AmountCell amountPaise={t.amountPaise} bankDeltaPaise={t.bankDeltaPaise} /></dd></div>
            <Row label="Member" value={t.memberName ?? "-"} />
            <Row label="Recorded by" value={t.recordedBy} />
            {t.approvedBy && <Row label="Approved by" value={t.approvedBy} />}
            {t.method && <Row label="Payment method" value={t.method.replace("_", " ").toLowerCase()} />}
            {t.paymentStatus && <Row label="Payment status" value={t.paymentStatus.toLowerCase()} />}
            {t.reference && <Row label="Payment reference" value={t.reference} />}
            {t.evidenceNote && <Row label="Evidence note" value={t.evidenceNote} />}
            {t.balanceAfterPaise !== null && t.balanceAfterPaise !== undefined && <Row label="Fund after this record" value={formatPaise(t.balanceAfterPaise)} />}
          </dl>
        </Card>

        <div>
          <h2 className="mb-3 text-lg font-semibold">Ledger lines</h2>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr><th className="px-4 py-3">Account</th><th className="px-4 py-3">Member</th><th className="px-4 py-3">Debit</th><th className="px-4 py-3">Credit</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3">{ACCOUNT_LABEL[l.account] ?? l.account}</td>
                    <td className="px-4 py-3">{l.memberName ?? "-"}</td>
                    <td className="px-4 py-3">{l.direction === "DEBIT" ? formatPaise(l.amountPaise) : ""}</td>
                    <td className="px-4 py-3">{l.direction === "CREDIT" ? formatPaise(l.amountPaise) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">Every record balances: total debits equal total credits. Records are never edited or deleted; corrections are new reversal records.</p>
        </div>

        {canReverse && (
          <Card>
            <h2 className="text-lg font-semibold">Correct a mistake</h2>
            <p className="mt-1 text-sm text-slate-600">If this deposit was recorded wrongly (wrong member or amount), reverse it, then record the right one. Only the President can do this.</p>
            <form onSubmit={(e) => void onReverse(e)} className="mt-4 max-w-xl space-y-3" noValidate>
              <TextAreaField label="Reason" name="rev-reason" rows={2} value={reason} onChange={setReason} error={reasonError} />
              <Button type="submit" variant="danger" loading={reverse.isPending}>Reverse this deposit</Button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
