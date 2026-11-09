import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { z } from "zod";
import { useAuth } from "../auth/AuthContext";
import { Alert, Button, Card, CheckField, SelectField, TextField } from "../components/ui";
import { useToast } from "../components/Toast";
import { api, errorMessage } from "../lib/api";
import { apiFieldErrors, zodErrors, type FieldErrors } from "../lib/forms";
import { parseDecimalToInt, percentToBps, rupeesToPaise } from "../lib/money";

type Method = "NONE" | "FLAT" | "REDUCING_BALANCE";
type Form = {
  name: string; description: string; contribution: string; maxMembers: string; dueDay: string;
  method: Method; rate: string; months: string;
  allowPartial: boolean; allowEarly: boolean; dual: boolean;
  holder: string; account: string; ifsc: string; upi: string;
};

const INITIAL: Form = {
  name: "", description: "", contribution: "200", maxMembers: "10", dueDay: "10",
  method: "NONE", rate: "", months: "12",
  allowPartial: true, allowEarly: true, dual: false,
  holder: "", account: "", ifsc: "", upi: "",
};

const whole = (min: number, max: number, message: string) =>
  z.string().refine((v) => {
    const n = parseDecimalToInt(v, 0);
    return n !== null && n >= min && n <= max;
  }, message);

const schema = z
  .object({
    name: z.string().trim().min(3, "At least 3 characters").max(80),
    description: z.string().trim().max(500),
    contribution: z.string().refine((v) => {
      const p = rupeesToPaise(v);
      return p !== null && p >= 1000 && p <= 100_000_000;
    }, "Enter an amount from ₹10 to ₹10,00,000"),
    maxMembers: whole(10, 20, "A group needs 10 to 20 members"),
    dueDay: whole(1, 28, "Pick a day from 1 to 28"),
    method: z.enum(["NONE", "FLAT", "REDUCING_BALANCE"]),
    rate: z.string(),
    months: whole(1, 60, "Enter 1 to 60 months"),
    holder: z.string().trim(),
    account: z.string().trim().refine((v) => v === "" || /^[0-9]{9,18}$/.test(v), "Account number must be 9 to 18 digits"),
    ifsc: z.string().trim().refine((v) => v === "" || /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(v), "Enter a valid IFSC code"),
    upi: z.string().trim().refine((v) => v === "" || /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/.test(v), "Enter a valid UPI ID"),
  })
  .superRefine((v, ctx) => {
    const bps = v.rate.trim() === "" ? 0 : percentToBps(v.rate);
    if (bps === null || bps > 10000) {
      ctx.addIssue({ code: "custom", path: ["rate"], message: "Enter a rate from 0% to 100%" });
    } else if (v.method !== "NONE" && bps === 0) {
      ctx.addIssue({ code: "custom", path: ["rate"], message: "Enter a rate above 0%, or choose No interest" });
    }
  });

const SERVER_FIELDS: Record<string, string> = {
  monthlyContributionPaise: "contribution", interestRateBps: "rate", contributionDueDay: "dueDay",
  defaultRepaymentMonths: "months", bankAccountHolder: "holder", bankAccountNumber: "account",
  bankIfsc: "ifsc", upiId: "upi",
};

export default function Welcome() {
  const { me, reload, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState<Form>(INITIAL);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me?.membership) return <Navigate to="/" replace />;

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = schema.safeParse(form);
    if (!parsed.success) return setErrors(zodErrors(parsed.error));
    setErrors({});

    const v = parsed.data;
    const body: Record<string, unknown> = {
      name: v.name,
      monthlyContributionPaise: rupeesToPaise(v.contribution),
      maxMembers: parseDecimalToInt(v.maxMembers, 0),
      contributionDueDay: parseDecimalToInt(v.dueDay, 0),
      interestMethod: v.method,
      interestRateBps: v.method === "NONE" ? 0 : percentToBps(v.rate),
      defaultRepaymentMonths: parseDecimalToInt(v.months, 0),
      allowPartialRepayment: form.allowPartial,
      allowEarlyRepayment: form.allowEarly,
      requireDualApproval: form.dual,
    };
    if (v.description) body.description = v.description;
    if (v.holder) body.bankAccountHolder = v.holder;
    if (v.account) body.bankAccountNumber = v.account;
    if (v.ifsc) body.bankIfsc = v.ifsc.toUpperCase();
    if (v.upi) body.upiId = v.upi;

    setBusy(true);
    try {
      await api("/api/groups", { method: "POST", body });
      await reload();
      toast.success("Group created. You're the President.");
      navigate("/", { replace: true });
    } catch (err) {
      setErrors(apiFieldErrors(err, SERVER_FIELDS));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Welcome, {me?.user.name}</h1>
          <p className="text-sm text-slate-600">You aren't in a group yet.</p>
        </div>
        <Button variant="secondary" onClick={() => void logout()}>Log out</Button>
      </div>

      <div className="mb-6">
        <Alert kind="info">
          Waiting for an invitation? Ask your group's President to invite <strong>{me?.user.email}</strong>, then open the link in the email. You can belong to only one group at a time.
        </Alert>
      </div>

      <Card>
        <h2 className="text-lg font-semibold">Create a new group</h2>
        <p className="mt-1 text-sm text-slate-600">You become its President. You can change most settings later.</p>

        <form onSubmit={onSubmit} className="mt-6 space-y-6" noValidate>
          {formError && <Alert kind="error">{formError}</Alert>}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <TextField label="Group name" name="name" value={form.name} onChange={(x) => set("name", x)} error={errors.name} placeholder="Mitra Savings Circle" />
            </div>
            <div className="sm:col-span-2">
              <TextField label="Description (optional)" name="description" value={form.description} onChange={(x) => set("description", x)} error={errors.description} />
            </div>
            <TextField label="Monthly contribution (₹)" name="contribution" inputMode="decimal" value={form.contribution} onChange={(x) => set("contribution", x)} error={errors.contribution} />
            <TextField label="Maximum members" name="maxMembers" inputMode="numeric" value={form.maxMembers} onChange={(x) => set("maxMembers", x)} error={errors.maxMembers} hint="10 to 20" />
            <TextField label="Contribution due day" name="dueDay" inputMode="numeric" value={form.dueDay} onChange={(x) => set("dueDay", x)} error={errors.dueDay} hint="Day of the month, 1 to 28" />
          </div>

          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold text-slate-900">Loan policy</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="Interest policy" name="method" value={form.method}
                onChange={(x) => set("method", x as Method)}
                options={[
                  { value: "NONE", label: "No interest" },
                  { value: "FLAT", label: "Flat interest" },
                  { value: "REDUCING_BALANCE", label: "Reducing balance" },
                ]}
              />
              {form.method !== "NONE" && (
                <TextField label="Interest rate (% per year)" name="rate" inputMode="decimal" value={form.rate} onChange={(x) => set("rate", x)} error={errors.rate} hint="A rate of 1% per month is 12% per year." />
              )}
              <TextField label="Default repayment period (months)" name="months" inputMode="numeric" value={form.months} onChange={(x) => set("months", x)} error={errors.months} />
            </div>
            <CheckField name="allowPartial" label="Allow partial repayments" checked={form.allowPartial} onChange={(x) => set("allowPartial", x)} />
            <CheckField name="allowEarly" label="Allow early repayments" checked={form.allowEarly} onChange={(x) => set("allowEarly", x)} />
            <CheckField name="dual" label="Require two administrators to approve withdrawals" hint="Recommended once you have a Vice President." checked={form.dual} onChange={(x) => set("dual", x)} />
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold text-slate-900">Where members pay (optional)</legend>
            <p className="text-xs text-slate-500">These details are shown to members so they know where to send money. This app never holds the money.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Account holder" name="holder" value={form.holder} onChange={(x) => set("holder", x)} error={errors.holder} />
              <TextField label="Account number" name="account" inputMode="numeric" value={form.account} onChange={(x) => set("account", x)} error={errors.account} />
              <TextField label="IFSC" name="ifsc" value={form.ifsc} onChange={(x) => set("ifsc", x)} error={errors.ifsc} />
              <TextField label="UPI ID" name="upi" value={form.upi} onChange={(x) => set("upi", x)} error={errors.upi} placeholder="group@okhdfc" />
            </div>
          </fieldset>

          <Button type="submit" loading={busy} className="w-full">Create group</Button>
        </form>
      </Card>
    </div>
  );
}
