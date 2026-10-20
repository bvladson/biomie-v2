import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { assessCoverage } from "@/domain/coverage";
import { useGlobalFilters } from "@/hooks/use-filters";
import { getDataCoverage } from "@/lib/coverage.functions";

const br = (day: string) => {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
};

/**
 * Explains periods that were not imported yet, so an empty screen is never read
 * as "no sales". DEMO companies have their own banner.
 */
export function CoverageBanner() {
  const { resolved, company, dataAsOf } = useGlobalFilters();
  const companyId = resolved?.company;
  const { data } = useQuery({
    queryKey: ["data-coverage", companyId],
    queryFn: () => getDataCoverage({ data: { company: companyId! } }),
    enabled: Boolean(companyId) && !company?.isDemo,
    staleTime: 5 * 60_000,
  });
  if (!resolved || !data || data.demo || company?.isDemo) return null;
  const assessment = assessCoverage(resolved.period, dataAsOf, data.entities.invoices ?? []);
  if (assessment.status === "covered") return null;
  const loaded = assessment.loaded
    ? `Notas importadas de ${br(assessment.loaded.from)} a ${br(assessment.loaded.to)}.`
    : "Nenhuma nota fiscal importada para esta empresa ainda.";
  return (
    <div
      role="status"
      className="flex items-start gap-2 border-t border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning md:px-6"
    >
      <CalendarClock className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {assessment.status === "partial"
          ? "Período parcialmente importado. "
          : "Período ainda não importado. "}
        {loaded} Valores zerados aqui não significam ausência de vendas.
      </span>
    </div>
  );
}
