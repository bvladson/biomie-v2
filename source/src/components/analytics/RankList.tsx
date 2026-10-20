import { formatValue } from "@/domain/format";

export function RankList({
  title,
  items,
}: {
  title: string;
  items: { label: string; value: number }[];
}) {
  const total = items.reduce((s, i) => s + i.value, 0);
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="panel p-4">
      <div className="eyebrow mb-3">{title}</div>
      {items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Sem dados no período.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {items.map((i) => (
            <li key={i.label} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate">{i.label}</span>
                <span className="shrink-0 font-medium tabular">
                  {formatValue(i.value, "currency_compact")}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-chart-1/70"
                  style={{ width: `${(i.value / max) * 100}%` }}
                />
              </div>
              <span className="sr-only">
                {total ? formatValue(i.value / total, "percent") : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
