// Contribution months and due dates follow Indian Standard Time (UTC+5:30, no daylight saving).
const IST_OFFSET_MS = 330 * 60 * 1000;

// Which calendar month is it in India at this instant?
export function periodOf(date: Date): { year: number; month: number } {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1 };
}

// The last moment of the due day, in IST. After this instant, an unpaid contribution is overdue.
export function dueDateFor(year: number, month: number, dueDay: number): Date {
  return new Date(Date.UTC(year, month - 1, dueDay, 23, 59, 59, 999) - IST_OFFSET_MS);
}

// Month number on a single scale, handy for comparing periods.
export const periodIndex = (year: number, month: number) => year * 12 + month;
