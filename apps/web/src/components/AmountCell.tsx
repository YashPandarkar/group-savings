import { formatPaise } from "../lib/money";

// Green + means money came IN to the group's records, red - means it went OUT (the group's point of view).
export function AmountCell({ amountPaise, bankDeltaPaise }: { amountPaise: number; bankDeltaPaise: number }) {
  const tone = bankDeltaPaise > 0 ? "text-green-700" : bankDeltaPaise < 0 ? "text-red-700" : "text-slate-700";
  const sign = bankDeltaPaise > 0 ? "+" : bankDeltaPaise < 0 ? "-" : "";
  return <span className={`font-medium ${tone}`}>{sign}{formatPaise(amountPaise)}</span>;
}
