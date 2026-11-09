import type { ReactNode } from "react";

type Tone = "slate" | "indigo" | "green" | "amber" | "red";
const TONES: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-700",
  indigo: "bg-indigo-100 text-indigo-700",
  green: "bg-green-100 text-green-800",
  amber: "bg-amber-100 text-amber-900",
  red: "bg-red-100 text-red-800",
};

export function Badge({ tone = "slate", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}
