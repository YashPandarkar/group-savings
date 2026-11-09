import { inputClass } from "./ui";

export function TextAreaField(props: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  rows?: number;
}) {
  return (
    <div>
      <label htmlFor={props.name} className="mb-1 block text-sm font-medium text-slate-700">{props.label}</label>
      <textarea
        id={props.name}
        name={props.name}
        rows={props.rows ?? 4}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-invalid={props.error ? true : undefined}
        className={inputClass}
      />
      {props.hint && !props.error && <p className="mt-1 text-xs text-slate-500">{props.hint}</p>}
      {props.error && <p className="mt-1 text-xs text-red-600">{props.error}</p>}
    </div>
  );
}
