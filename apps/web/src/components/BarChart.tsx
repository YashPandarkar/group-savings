// A dependency-free bar chart. Always show the same numbers in a table too (screen readers and printing).
export function BarChart({
  data,
  format,
  ariaLabel,
}: {
  data: { label: string; value: number }[];
  format: (n: number) => string;
  ariaLabel: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div role="img" aria-label={ariaLabel} className="flex h-52 gap-2 rounded-xl border border-slate-200 bg-white p-4">
      {data.map((d) => (
        <div key={d.label} className="flex h-full min-w-0 flex-1 flex-col" title={`${d.label}: ${format(d.value)}`}>
          <div className="relative flex-1">
            <div
              className="absolute bottom-0 w-full rounded-t bg-indigo-500"
              style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value > 0 ? 2 : 0 }}
            />
          </div>
          <span className="mt-1 text-center text-[10px] text-slate-500">{d.label}</span>
        </div>
      ))}
    </div>
  );
}
