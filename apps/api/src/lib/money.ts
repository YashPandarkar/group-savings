// All money is integer PAISE (₹1 = 100 paise). The database stores BigInt.
// JSON can't carry BigInt, so at the API boundary we convert to a plain number.

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

export function paiseToNumber(value: bigint): number {
  if (value > MAX || value < -MAX) throw new Error("Amount too large to serialize");
  return Number(value);
}

// "1234.50": for human-readable messages only. Uses integer math, never floats.
export function formatRupees(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const rupees = abs / 100n;
  const rest = String(abs % 100n).padStart(2, "0");
  return `${negative ? "-" : ""}₹${rupees}.${rest}`;
}
