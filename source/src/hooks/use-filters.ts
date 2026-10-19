import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  COMPANY_SCOPED_KEYS,
  currentPeriod,
  type AnalyticsQuery,
  type GlobalFilters,
} from "@/domain/filters";
import { appContextQuery } from "@/lib/queries";

/** Raw URL filters + resolved values (company & period always defined). */
export function useGlobalFilters() {
  const search = useSearch({ from: "/_authenticated/_shell" }) as GlobalFilters;
  const navigate = useNavigate();
  const { data: ctx } = useSuspenseQuery(appContextQuery());

  const company =
    (search.company && ctx.companies.some((c) => c.id === search.company) && search.company) ||
    (ctx.defaultCompanyId &&
      ctx.companies.some((c) => c.id === ctx.defaultCompanyId) &&
      ctx.defaultCompanyId) ||
    ctx.companies[0]?.id ||
    null;

  const companyInfo = ctx.companies.find((c) => c.id === company) ?? null;
  /** Reference date for all temporal calculations (demo-aware, from the server). */
  const dataAsOf = companyInfo?.dataAsOf || null;

  const resolved: AnalyticsQuery | null = useMemo(
    () =>
      company
        ? {
            company,
            period: search.period ?? (dataAsOf ? dataAsOf.slice(0, 7) : currentPeriod()),
            channel: search.channel,
            branch: search.branch,
            seller: search.seller,
            state: search.state,
            city: search.city,
            category: search.category,
          }
        : null,
    [company, search, dataAsOf],
  );

  const setFilters = useCallback(
    (patch: Partial<GlobalFilters>) => {
      navigate({
        to: ".",
        replace: true,
        search: (prev: GlobalFilters) => {
          const next: GlobalFilters = { ...prev, ...patch };
          if (patch.company && patch.company !== prev.company)
            for (const k of COMPANY_SCOPED_KEYS) next[k] = undefined;
          if (patch.state !== undefined && patch.state !== prev.state) next.city = undefined;
          return next;
        },
      } as never);
    },
    [navigate],
  );

  const clear = useCallback(() => {
    navigate({
      to: ".",
      replace: true,
      search: (prev: GlobalFilters) => ({ company: prev.company, period: prev.period }),
    } as never);
  }, [navigate]);

  const activeCount = COMPANY_SCOPED_KEYS.filter((k) => search[k]).length;

  return {
    search,
    resolved,
    setFilters,
    clear,
    activeCount,
    companies: ctx.companies,
    company: companyInfo,
    dataAsOf,
  };
}
