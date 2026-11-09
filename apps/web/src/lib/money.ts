// The API speaks integer PAISE (Rs 1 = 100 paise). Floats are used only to DISPLAY.
const grouping = new Intl.NumberFormat("en-IN");

export function formatPaise(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}₹${grouping.format(rupees)}.${rest}`;
}

// "200" -> 20000, "200.5" -> 20050, "1,000.25" -> 100025. Pure string work, no floating point.
// Returns null for anything that isn't a plain non-negative number with at most `scale` decimals.
export function parseDecimalToInt(input: string, scale: number): number | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(input.trim().replace(/,/g, ""));
  if (!m) return null;
  const fraction = m[2] ?? "";
  if (fraction.length > scale) return null;
  const n = Number(m[1] + fraction.padEnd(scale, "0"));
  return Number.isSafeInteger(n) ? n : null;
}

export const rupeesToPaise = (input: string): number | null => parseDecimalToInt(input, 2);
// 12 -> 1200 basis points (the API's unit for interest rates)
export const percentToBps = (input: string): number | null => parseDecimalToInt(input, 2);
export const bpsToPercent = (bps: number): string => (bps / 100).toFixed(2).replace(/\.00$/, "");

// 20050 -> "200.5", for pre-filling an input
export const paiseToInput = (paise: number): string => (paise / 100).toFixed(2).replace(/\.00$/, "");
