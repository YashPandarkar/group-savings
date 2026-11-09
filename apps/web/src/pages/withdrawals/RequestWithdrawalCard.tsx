import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, SelectField, TextField } from "../../components/ui";
import { useToast } from "../../components/Toast";
import { api, errorMessage } from "../../lib/api";
import { apiFieldErrors, type FieldErrors } from "../../lib/forms";
import { formatPaise, rupeesToPaise } from "../../lib/money";
import { useGroup, useMembers } from "../../lib/queries";
import { useFundReport } from "../../lib/reports";

export default function RequestWithdrawalCard({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const { me } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const group = useGroup();
  const members = useMembers();
  const fund = useFundReport(true);

  const [kind, setKind] = useState("MEMBER_PAYOUT");
  const [beneficiary, setBeneficiary] = useState("");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("Payout of savings");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const savings = new Map((fund.data?.memberBalances ?? []).map((b) => [b.userId, b.savingsPaise]));
  const options = [
    { value: "", label: "Choose…" },
    ...(members.data?.members ?? []).map((m) => ({
      value: m.userId,
      label: savings.has(m.userId) ? `${m.name} (savings ${formatPaise(savings.get(m.userId) ?? 0)})` : m.name,
    })),
  ];
  const ownPayout = kind === "MEMBER_PAYOUT" && beneficiary === me!.user.id;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const paise = rupeesToPaise(amount);
    const next: FieldErrors = {};
    if (kind === "MEMBER_PAYOUT" && !beneficiary) next.beneficiary = "Choose whose savings are paid out";
    if (paise === null || paise < 100) next.amount = "Enter an amount of at least ₹1";
    if (purpose.trim().length < 5) next.purpose = "Describe the purpose (at least 5 characters)";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const body: Record<string, unknown> = { kind, amountPaise: paise, purpose: purpose.trim() };
    if (kind === "MEMBER_PAYOUT") body.beneficiaryUserId = beneficiary;

    setBusy(true);
    try {
      const res = await api<{ replayed: boolean; withdrawal: { id: string } }>(`/api/groups/${groupId}/withdrawals`, { method: "POST", body });
      toast.success(res.replayed ? "That request already exists." : "Withdrawal requested.");
      void qc.invalidateQueries();
      navigate(`/withdrawals/${res.withdrawal.id}`);
    } catch (err) {
      setErrors(apiFieldErrors(err, { amountPaise: "amount", beneficiaryUserId: "beneficiary" }));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Request a withdrawal</h2>
      <p className="mt-1 text-sm text-slate-600">
        This only <strong>records an authorisation</strong>. No money moves until you send it yourself and record the transfer.
      </p>
      <form onSubmit={onSubmit} className="mt-4 max-w-xl space-y-4" noValidate>
        {formError && <Alert kind="error">{formError}</Alert>}
        <SelectField
          label="Type" name="w-kind" value={kind}
          onChange={(v) => { setKind(v); setPurpose(v === "MEMBER_PAYOUT" ? "Payout of savings" : ""); }}
          options={[
            { value: "MEMBER_PAYOUT", label: "Pay out a member's savings" },
            { value: "GROUP_EXPENSE", label: "Group expense (paid from interest earned only)" },
          ]}
        />
        {kind === "MEMBER_PAYOUT" && (
          <SelectField label="Member" name="w-beneficiary" value={beneficiary} onChange={setBeneficiary} options={options} error={errors.beneficiary}
            hint="Limited to their savings, less what they still owe on loans." />
        )}
        <TextField label="Amount (₹)" name="w-amount" inputMode="decimal" value={amount} onChange={setAmount} error={errors.amount} />
        <TextField label="Purpose" name="w-purpose" value={purpose} onChange={setPurpose} error={errors.purpose} />
        {ownPayout && <Alert kind="info">You're paying out your own savings, so the other administrator must approve and record the transfer.</Alert>}
        {!ownPayout && group.data?.requireDualApproval && <Alert kind="info">This group needs a second administrator's approval.</Alert>}
        <div className="flex gap-3">
          <Button type="submit" loading={busy}>Request withdrawal</Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
