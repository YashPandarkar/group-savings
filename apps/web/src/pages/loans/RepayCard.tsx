import { useState, type FormEvent } from "react";
import { Button, Card, TextField } from "../../components/ui";
import { usePayment } from "../../components/PaymentFlow";
import { useToast } from "../../components/Toast";
import type { Loan } from "../../lib/loans";
import { formatPaise, paiseToInput, rupeesToPaise } from "../../lib/money";

// The BORROWER pays an installment online. The server re-checks the amount and the group's rules.
export default function RepayCard({ loan }: { loan: Loan }) {
  const { startPayment } = usePayment();
  const toast = useToast();
  const next = loan.nextDue?.remainingPaise ?? 0;
  const total = loan.outstandingPaise ?? 0;
  const [amount, setAmount] = useState(next > 0 ? paiseToInput(next) : "");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const paise = rupeesToPaise(amount);
    if (paise === null || paise < 100) return setError("Enter an amount of at least ₹1.");
    if (paise > total) return setError(`Only ${formatPaise(total)} is outstanding.`);
    setError(undefined);
    setBusy(true);
    const result = await startPayment({
      groupId: loan.groupId, purpose: "LOAN_REPAYMENT", amountPaise: paise, loanId: loan.id, label: "Loan repayment",
    });
    setBusy(false);
    if (result === "SUCCESS") toast.success("Repayment received.");
    if (result === "FAILED") toast.error("The payment didn't go through.");
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Repay online</h2>
      <p className="mt-1 text-sm text-slate-600">Payments go to your oldest unpaid installment first, interest before principal.</p>
      <form onSubmit={onSubmit} className="mt-4 max-w-md space-y-4" noValidate>
        <TextField label="Amount (₹)" name="repay-amount" inputMode="decimal" value={amount} onChange={setAmount} error={error} />
        <div className="flex flex-wrap gap-2 text-sm">
          {next > 0 && <Button variant="secondary" onClick={() => setAmount(paiseToInput(next))}>Next installment ({formatPaise(next)})</Button>}
          {total > 0 && <Button variant="secondary" onClick={() => setAmount(paiseToInput(total))}>Everything ({formatPaise(total)})</Button>}
        </div>
        <Button type="submit" loading={busy}>Continue to payment</Button>
      </form>
    </Card>
  );
}
