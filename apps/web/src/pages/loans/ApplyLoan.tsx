import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, PageHeader, SelectField, Spinner, TextField } from "../../components/ui";
import { PreviewTable } from "../../components/Schedule";
import { useToast } from "../../components/Toast";
import { api, errorMessage } from "../../lib/api";
import { apiFieldErrors, type FieldErrors } from "../../lib/forms";
import { useDebounced } from "../../lib/hooks";
import type { Loan, PreviewRow } from "../../lib/loans";
import { formatPaise, parseDecimalToInt, rupeesToPaise } from "../../lib/money";
import { useGroup } from "../../lib/queries";

type Quote = {
  policy: string; installmentCount: number; repaymentFrequency: string; principalPaise: number;
  totalInterestPaise: number; totalRepayablePaise: number; installments: PreviewRow[]; note: string;
};

export default function ApplyLoan() {
  const { me } = useAuth();
  const groupId = me!.membership!.groupId;
  const navigate = useNavigate();
  const toast = useToast();
  const group = useGroup();

  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [count, setCount] = useState("");
  const [frequency, setFrequency] = useState("MONTHLY");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const paise = rupeesToPaise(amount);
  const maxCount = frequency === "WEEKLY" ? 156 : 60;
  const countValue = count.trim() === "" ? undefined : parseDecimalToInt(count, 0);
  const countOk = count.trim() === "" || (countValue !== null && countValue !== undefined && countValue >= 1 && countValue <= maxCount);
  const amountOk = paise !== null && paise >= 10000 && paise <= 1_000_000_000;

  // The quote is asked for only after typing pauses, and only for valid input.
  const qs = amountOk && countOk
    ? `principalPaise=${paise}&repaymentFrequency=${frequency}${countValue ? `&installmentCount=${countValue}` : ""}`
    : null;
  const debouncedQs = useDebounced(qs, 400);
  const quote = useQuery({
    queryKey: ["loan-quote", groupId, debouncedQs],
    enabled: debouncedQs !== null,
    retry: false,
    queryFn: () => api<Quote>(`/api/groups/${groupId}/loans/quote?${debouncedQs}`),
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const next: FieldErrors = {};
    if (!amountOk) next.amount = "Enter an amount from ₹100 up to ₹1,00,00,000";
    if (purpose.trim().length < 5) next.purpose = "Describe the purpose (at least 5 characters)";
    if (!countOk) next.count = `Enter 1 to ${maxCount} installments, or leave it empty`;
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const body: Record<string, unknown> = { principalPaise: paise, purpose: purpose.trim(), repaymentFrequency: frequency };
    if (countValue) body.installmentCount = countValue;

    setBusy(true);
    try {
      const res = await api<{ loan: Loan }>(`/api/groups/${groupId}/loans`, { method: "POST", body });
      toast.success("Loan application sent.");
      navigate(`/loans/${res.loan.id}`, { replace: true });
    } catch (err) {
      setErrors(apiFieldErrors(err, { principalPaise: "amount", installmentCount: "count" }));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const defaultMonths = group.data?.defaultRepaymentMonths;

  return (
    <>
      <Link to="/loans" className="mb-4 inline-block text-sm text-indigo-600">← All loans</Link>
      <PageHeader title="Apply for a loan" subtitle="The interest policy is the group's. It is fixed for your loan when you apply." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {formError && <Alert kind="error">{formError}</Alert>}
            <TextField label="Amount (₹)" name="loan-amount" inputMode="decimal" value={amount} onChange={setAmount} error={errors.amount} />
            <TextField label="Purpose" name="loan-purpose" value={purpose} onChange={setPurpose} error={errors.purpose} placeholder="Medical expenses, shop inventory…" />
            <SelectField label="Repayment frequency" name="loan-frequency" value={frequency} onChange={setFrequency}
              options={[{ value: "MONTHLY", label: "Monthly" }, { value: "WEEKLY", label: "Weekly" }]} />
            <TextField label="Number of installments (optional)" name="loan-count" inputMode="numeric" value={count} onChange={setCount} error={errors.count}
              hint={defaultMonths ? `Empty = the group's default (${defaultMonths} months).` : undefined} />
            <Button type="submit" loading={busy} className="w-full">Send application</Button>
          </form>
        </Card>

        <div>
          <h2 className="mb-3 text-lg font-semibold">What you would repay</h2>
          {debouncedQs === null && <p className="text-sm text-slate-500">Enter an amount to see your schedule.</p>}
          {quote.isFetching && <Spinner />}
          {quote.isError && <Alert kind="error">{errorMessage(quote.error)}</Alert>}
          {quote.data && !quote.isFetching && (
            <div className="space-y-4">
              <Alert kind="info">{quote.data.policy}</Alert>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <Card className="p-3"><p className="text-slate-500">Borrow</p><p className="font-bold">{formatPaise(quote.data.principalPaise)}</p></Card>
                <Card className="p-3"><p className="text-slate-500">Interest</p><p className="font-bold">{formatPaise(quote.data.totalInterestPaise)}</p></Card>
                <Card className="p-3"><p className="text-slate-500">Total</p><p className="font-bold">{formatPaise(quote.data.totalRepayablePaise)}</p></Card>
              </div>
              <PreviewTable rows={quote.data.installments} />
              <p className="text-xs text-slate-500">{quote.data.note} Due dates are set when the money is sent.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
