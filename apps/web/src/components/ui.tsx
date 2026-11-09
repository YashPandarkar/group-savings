import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Spinner({ size = "md" }: { size?: "sm" | "md" }) {
  const dim = size === "sm" ? "h-4 w-4 border-2" : "h-8 w-8 border-4";
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-slate-300 border-t-indigo-600 ${dim}`}
    />
  );
}

export function FullPageSpinner() {
  return (
    <div className="flex h-full min-h-screen items-center justify-center">
      <Spinner />
    </div>
  );
}

type Variant = "primary" | "secondary" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700",
  secondary: "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

export function Button({
  variant = "primary",
  loading = false,
  disabled,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      {...rest}
      type={rest.type ?? "button"}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  );
}

export const inputClass =
  "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-100 aria-[invalid=true]:border-red-500";

function FieldShell(props: { label: string; name: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={props.name} className="mb-1 block text-sm font-medium text-slate-700">
        {props.label}
      </label>
      {props.children}
      {props.hint && !props.error && <p className="mt-1 text-xs text-slate-500">{props.hint}</p>}
      {props.error && (
        <p id={`${props.name}-error`} className="mt-1 text-xs text-red-600">
          {props.error}
        </p>
      )}
    </div>
  );
}

export function TextField(props: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "decimal" | "email";
  disabled?: boolean;
}) {
  return (
    <FieldShell label={props.label} name={props.name} error={props.error} hint={props.hint}>
      <input
        id={props.name}
        name={props.name}
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? `${props.name}-error` : undefined}
        className={inputClass}
      />
    </FieldShell>
  );
}

export function SelectField(props: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  error?: string;
  hint?: string;
}) {
  return (
    <FieldShell label={props.label} name={props.name} error={props.error} hint={props.hint}>
      <select
        id={props.name}
        name={props.name}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className={inputClass}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function CheckField(props: {
  label: string;
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={props.name}
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600"
      />
      <label htmlFor={props.name} className="text-sm text-slate-700">
        {props.label}
        {props.hint && <span className="block text-xs text-slate-500">{props.hint}</span>}
      </label>
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>{children}</div>;
}

type AlertKind = "error" | "info" | "success" | "warning";
const ALERTS: Record<AlertKind, string> = {
  error: "border-red-200 bg-red-50 text-red-800",
  info: "border-sky-200 bg-sky-50 text-sky-800",
  success: "border-green-200 bg-green-50 text-green-800",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
};

export function Alert({ kind = "info", children }: { kind?: AlertKind; children: ReactNode }) {
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`rounded-lg border px-4 py-3 text-sm ${ALERTS[kind]}`}>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// The centred card used by login, register and friends.
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <p className="mb-6 text-center text-sm font-semibold uppercase tracking-wide text-indigo-600">
          Group Savings &amp; Loans
        </p>
        <Card className="p-6 sm:p-8">
          <h1 className="text-xl font-bold text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </Card>
        {footer && <div className="mt-4 text-center text-sm text-slate-600">{footer}</div>}
      </div>
    </div>
  );
}
