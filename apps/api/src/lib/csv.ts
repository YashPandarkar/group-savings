// Cells that start with these characters can be executed as formulas by Excel/Sheets.
const FORMULA_START = /^[=+\-@\t\r]/;

// For TEXT cells (names, descriptions, references): neutralise formulas, then quote if needed.
export function csvText(value: string | null | undefined): string {
  let s = value ?? "";
  if (FORMULA_START.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// For cells WE generate (numbers, fixed words). Never pass user-typed text here.
export const csvRaw = (value: string | number): string => String(value);

export const csvRow = (cells: string[]): string => cells.join(",");
