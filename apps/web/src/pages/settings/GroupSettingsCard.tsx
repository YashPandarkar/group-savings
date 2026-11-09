import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useAuth } from "../../auth/AuthContext";
import { Alert, Button, Card, CheckField, SelectField, TextField } from "../../components/ui";
import { TextAreaField } from "../../components/TextArea";
import { useToast } from "../../components/Toast";
import { api, errorMessage } from "../../lib/api";
import { apiFieldErrors, zodErrors, type FieldErrors } from "../../lib/forms";
import { bpsToPercent, formatPaise, parseDecimalToInt, percentToBps, rupeesToPaise } from "../../lib/money";
import { INTEREST_LABEL, type Group, type InterestMethod } from "../../lib/types";

type Form = {
  name: string; description: string; contribution: string; maxMembers: string; dueDay: string; rules: string;
  method: InterestMethod; rate: string; months: string;
  allowPartial: boolean; allowEarly: boolean; dual: boolean;
  holder: string; account: string; ifsc: string; upi: string;
};

const toRupees = (paise: number) => (paise / 100).toFixed(2).replace(/\.00$/, "");

const fromGroup = (g: Group): Form => ({
  name: g.name,
  description: g.description ?? "",
  contribution: toRupees(g.monthlyContributionPaise),
  maxMembers: String(g.maxMembers),
  dueDay: String(g.contributionDueDay),
  rules: g.rules ?? "",
  method: g.interestMethod,
  rate: g.interestRateBps > 0 ? bpsToPercent(g.interestRateBps) : "",
  months: String(g.defaultRepaymentMonths),
  allowPartial: g.allowPartialRepayment,
  allowEarly: g.allowEarlyRepayment,
  dual: g.requireDualApproval,
  holder: g.payment.accountHolder ?? "",
  account: g.payment.accountNumber ?? "",
  ifsc: g.payment.ifsc ?? "",
  upi: g.payment.upiId ?? "",
});

const whole = (min: number, max: number, message: string) =>
  z.string().refine((v) => {
    const n = parseDecimalToInt(v, 0);
    return n !== null && n >= min && n <= max;
  }, message);

const schema = z
  .object({
    name: z.string().trim().min(3, "At least 3 characters").max(80),
    description: z.string().trim().max(500),
    rules: z.string().trim().max(5000, "Rules are too long"),
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
  bankIfsc: "ifsc", upiId: "upi", interestMethod: "method",
};

// The President edits; everyone else just reads (members need the payment details).
export default function GroupSettingsCard({ group, canEdit }: { group: Group; canEdit: boolean }) {
  return canEdit ? <EditForm group={group} /> : <Summary group={group} />;
}

function EditForm({ group }: { group: Group }) {
  const { reload } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Form>(() => fromGroup(group));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      description: v.description, // an empty string clears it
      rules: v.rules,
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
    if (v.holder) body.bankAccountHolder = v.holder;
    if (v.account) body.bankAccountNumber = v.account;
    if (v.ifsc) body.bankIfsc = v.ifsc.toUpperCase();
    if (v.upi) body.upiId = v.upi;

    setBusy(true);
    try {
      await api(`/api/groups/${group.id}`, { method: "PUT", body });
      await qc.invalidateQueries({ queryKey: ["group", group.id] });
      await reload(); // the sidebar shows the group name
      toast.success("Group settings saved.");
    } catch (err) {
      setErrors(apiFieldErrors(err, SERVER_FIELDS));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold">Group settings</h2>
      <p className="mt-1 text-sm text-slate-600">Only the President can change these.</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-8" noValidate>
        {formError && <Alert kind="error">{formError}</Alert>}

        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-slate-900">Basics</legend>
          <TextField label="Group name" name="g-name" value={form.name} onChange={(x) => set("name", x)} error={errors.name} />
          <TextField label="Description" name="g-description" value={form.description} onChange={(x) => set("description", x)} error={errors.description} />
          <TextAreaField label="Group rules" name="g-rules" value={form.rules} onChange={(x) => set("rules", x)} error={errors.rules} hint="Shown to every member." />
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-slate-900">Contributions</legend>
          <Alert kind="info">A new monthly amount applies to months that haven't been generated yet. Existing months keep the amount they were created with.</Alert>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField label="Monthly contribution (₹)" name="g-contribution" inputMode="decimal" value={form.contribution} onChange={(x) => set("contribution", x)} error={errors.contribution} />
            <TextField label="Due day of the month" name="g-dueDay" inputMode="numeric" value={form.dueDay} onChange={(x) => set("dueDay", x)} error={errors.dueDay} hint="1 to 28" />
            <TextField label="Maximum members" name="g-maxMembers" inputMode="numeric" value={form.maxMembers} onChange={(x) => set("maxMembers", x)} error={errors.maxMembers} hint="10 to 20" />
          </div>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-slate-900">Loan policy</legend>
          <Alert kind="warning">Changes apply to <strong>new loan applications only</strong>. Loans already applied for keep the terms they were created with.</Alert>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Interest policy" name="g-method" value={form.method}
              onChange={(x) => set("method", x as InterestMethod)}
              options={(Object.keys(INTEREST_LABEL) as InterestMethod[]).map((k) => ({ value: k, label: INTEREST_LABEL[k] }))}
              error={errors.method}
            />
            {form.method !== "NONE" && (
              <TextField label="Interest rate (% per year)" name="g-rate" inputMode="decimal" value={form.rate} onChange={(x) => set("rate", x)} error={errors.rate} hint="A rate of 1% per month is 12% per year." />
            )}
            <TextField label="Default repayment period (months)" name="g-months" inputMode="numeric" value={form.months} onChange={(x) => set("months", x)} error={errors.months} />
          </div>
          <CheckField name="g-partial" label="Allow partial repayments" checked={form.allowPartial} onChange={(x) => set("allowPartial", x)} />
          <CheckField name="g-early" label="Allow early repayments" checked={form.allowEarly} onChange={(x) => set("allowEarly", x)} />
          <CheckField name="g-dual" label="Require two administrators to approve withdrawals" hint="Needs a Vice President. Recommended for real money." checked={form.dual} onChange={(x) => set("dual", x)} />
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-slate-900">Where members pay</legend>
          <p className="text-xs text-slate-500">Shown to members so they know where to send money. This app never holds the money. To replace a value, type the new one (clearing a saved value isn't supported).</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Account holder" name="g-holder" value={form.holder} onChange={(x) => set("holder", x)} error={errors.holder} />
            <TextField label="Account number" name="g-account" inputMode="numeric" value={form.account} onChange={(x) => set("account", x)} error={errors.account} />
            <TextField label="IFSC" name="g-ifsc" value={form.ifsc} onChange={(x) => set("ifsc", x)} error={errors.ifsc} />
            <TextField label="UPI ID" name="g-upi" value={form.upi} onChange={(x) => set("upi", x)} error={errors.upi} />
          </div>
        </fieldset>

        <Button type="submit" loading={busy}>Save group settings</Button>
      </form>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1 font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function Summary({ group: g }: { group: Group }) {
  const interest =
    g.interestMethod === "NONE" ? "No interest" : `${INTEREST_LABEL[g.interestMethod]} at ${bpsToPercent(g.interestRateBps)}% per year`;
  return (
    <Card>
      <h2 className="text-lg font-semibold">Group settings</h2>
      <p className="mt-1 text-sm text-slate-600">Only the President can change these.</p>
      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
        <Row label="Monthly contribution" value={formatPaise(g.monthlyContributionPaise)} />
        <Row label="Due day of the month" value={String(g.contributionDueDay)} />
        <Row label="Loan interest" value={interest} />
        <Row label="Default repayment period" value={`${g.defaultRepaymentMonths} months`} />
        <Row label="Partial repayments" value={g.allowPartialRepayment ? "Allowed" : "Not allowed"} />
        <Row label="Early repayments" value={g.allowEarlyRepayment ? "Allowed" : "Not allowed"} />
        <Row label="Withdrawals" value={g.requireDualApproval ? "Need two administrators" : "One administrator can approve"} />
      </dl>
      {g.rules && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Group rules</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{g.rules}</p>
        </div>
      )}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Where to pay</h3>
        {g.payment.accountHolder || g.payment.accountNumber || g.payment.upiId ? (
          <dl className="mt-2 grid gap-4 text-sm sm:grid-cols-2">
            {g.payment.accountHolder && <Row label="Account holder" value={g.payment.accountHolder} />}
            {g.payment.accountNumber && <Row label="Account number" value={g.payment.accountNumber} />}
            {g.payment.ifsc && <Row label="IFSC" value={g.payment.ifsc} />}
            {g.payment.upiId && <Row label="UPI ID" value={g.payment.upiId} />}
          </dl>
        ) : (
          <p className="mt-1 text-sm text-slate-500">The President hasn't added payment details yet.</p>
        )}
      </div>
    </Card>
  );
}
