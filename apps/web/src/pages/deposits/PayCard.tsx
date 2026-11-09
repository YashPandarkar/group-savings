import { useState, type FormEvent } from "react";
import { Alert, Button, Card, SelectField, TextField } from "../../components/ui";
import type { Contribution } from "../../components/ContributionTable";
import { usePayment } from "../../components/PaymentFlow";
import { useToast } from "../../components/Toast";
import { MONTH_NAMES } from "../../lib/format";
import { formatPaise, paiseToInput, rupeesToPaise } from "../../lib/money";

type Purpose = "MONTHLY_DEPOSIT" | "ADDITIONAL_DEPOSIT";

// `due` is the member's OLDEST unpaid contribution (the server applies payments oldest-first too).
export default function PayCard({ groupId, due }: { groupId: string; due: Contribution | undefined }) {
  const { startPayment } = usePayment();
  const toast = useToast();
  const [purpose, setPurpose] = useState<Purpose>(due ? "MONTHLY_DEPOSIT" : "ADDITIONAL_DEPOSIT");
  const [amount, setAmount] = useState(due ? paiseToInput(due.remainingPaise) : "");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  function changePurpose(value: string) {
    const next: Purpose = value === "MONTHLY_DEPOSIT" ? "MONTHLY_DEPOSIT" : "ADDITIONAL_DEPOSIT";
    setPurpose(next);
    setAmount(next === "MONTHLY_DEPOSIT" && due ? paiseToInput(due.remainingPaise) : "");
    setError(undefined);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const paise = rupeesToPaise(amount);
    if (paise === null || paise < 100) return setError("Enter an amount of at least ₹1 (up to 2 decimals).");
    if (paise > 100_000_000) return setError("The maximum is ₹10,00,000 per payment.");
    if (purpose === "MONTHLY_DEPOSIT" && due && paise > due.remainingPaise) {
      return setError(`Only ${formatPaise(due.remainingPaise)} is due. Pay anything extra as an additional deposit.`);
    }
    setError(undefined);
    setBusy(true);
    const label = purpose === "MONTHLY_DEPOSIT" && due
      ? `Monthly contribution, ${MONTH_NAMES[due.periodMonth - 1]} ${due.periodYear}`
      : "Additional deposit to your savings";
    const result = await startPayment({ groupId, purpose, amountPaise: paise, label });
    setBusy(false);
    if (result === "SUCCESS") toast.success("Payment received.");
    if (result === "FAILED") toast.error("The payment didn't go through.");
  }

  const options = [
    ...(due ? [{ value: "MONTHLY_DEPOSIT", label: `Monthly contribution (${formatPaise(due.remainingPaise)} due)` }] : []),
    { value: "ADDITIONAL_DEPOSIT", label: "Additional deposit" },
  ];

  return (
    <Card>
      <h2 className="text-lg font-semibold">Pay online</h2>
      {!due && <p className="mt-1 text-sm text-slate-600">Your monthly contributions are all paid. You can still add to your savings.</p>}
      <form onSubmit={onSubmit} className="mt-4 max-w-md space-y-4" noValidate>
        <SelectField label="What are you paying?" name="pay-purpose" value={purpose} onChange={changePurpose} options={options} />
        <TextField label="Amount (₹)" name="pay-amount" inputMode="decimal" value={amount} onChange={setAmount} error={error} />
        <Button type="submit" loading={busy}>Continue to payment</Button>
      </form>
      <div className="mt-4"><Alert kind="info">Your payment counts only after the payment provider confirms it. The app never trusts the browser's word alone.</Alert></div>
    </Card>
  );
}
