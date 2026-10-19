<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

## Architecture rules

- Metric definitions live only in `src/domain/metrics/registry.ts`; derived ratios only in `src/domain/metrics/compute.ts` — never compute formulas in components (single source of truth).
- Aggregations run in Postgres semantic functions (`fact_sales`, `sales_aggregate`, `cockpit_summary`, SECURITY INVOKER) so RLS always applies to analytics.
- Server functions in `src/lib/*.functions.ts` delegate data access to `src/lib/repositories/*.server.ts` (thin RPC layer, testable repositories).
- Global filters are URL search params validated by `globalFiltersSchema` on the `_authenticated/_shell` layout with `retainSearchParams` (shareable, persist across navigation); read via `useGlobalFilters`.
- Authorization is enforced by RLS helpers (`can_access_company`, `can_view_seller`, `is_admin`); `src/domain/rbac.ts` permissions are UI hints only.
- Roles are in `user_roles`; `ensure_app_profile()` provisions new users atomically as VIEWER. Administrators are provisioned explicitly during deployment (no automatic first-user promotion or triggers on auth schema).
- Demo data is flagged via `companies.is_demo` / `source='demo'` and always surfaced with the demo badge.
- Revenue valid statuses are configurable in `metric_config` (key `revenue`), read by `revenue_valid_statuses()`.
- Flight Plan actions are derived deterministically on read; only their workflow status is persisted (`flight_plan_actions`), keyed by company/seller/period/type.
- Fonts are self-hosted via @fontsource (no external render-blocking stylesheets; keeps SSR/tests deterministic).
- `public.data_as_of(company)` is the only source of "today" for analytics (demo = last demo invoice date); SQL read models and the UI default period use it, never `new Date()` in screens.
- Open orders are item-level (`sales_order_items` via `fact_orders`) so every global filter, including category, applies to Carteira.
- `assert_company_access` lets `service_role` bypass the company check so trusted server jobs can reuse the same read models.
- Flight Plan snapshots are written only by the job in `src/lib/jobs/flight-plan-snapshots.server.ts` (route `/api/public/jobs/flight-plan-snapshots`, pg_cron daily, token in `private.job_secrets`); every run is logged in `job_runs`.
- Exports (CSV/XLSX) are generated client-side from the same server result shown on screen (`src/lib/export.ts`), so files always match the applied filters.
- The active target level has one definition: `metric_config.flight_plan.activeLevel`, read in SQL by `public.active_target_level()` (Cockpit) and in TS by `resolveConfig` (Plano de Voo, Vendas, Vendedor 360); snapshots store the level and value used.
- Seller visibility is `can_view_seller`: broad roles see all; GESTOR sees sellers in teams it currently manages; VENDEDOR sees itself. Every fact/customer policy goes through it, so scope is server-side for all read models.
- Team membership/manager history is kept by closing `valid_to` (never delete), so team changes don't rewrite past analyses.
- Drill-down links keep global filters by passing the current search through (`keepSearch`/`withSearch` in `src/components/entities/shared.tsx`).
- Read RLS policies evaluate scope once per statement via `accessible_company_ids()` / `visible_seller_ids()` / `visible_customer_ids()` wrapped in `(SELECT ...)`; per-row helper calls caused statement timeouts for GESTOR. Write checks may keep `can_view_seller`.
- CPF/CNPJ: raw `customers.document` is not selectable by app roles; read models return `customer_document()` (always masked). Full value only through `reveal_customer_document(id, reason)`, gated by `user_permissions` (`documents:view_full`) and always written to `audit_log`.
- Finance access is capability-based (`src/domain/finance.ts`): role defaults plus `user_permissions` grants, enforced server-side; overdue data is stripped for users without `finance.view_overdue`, and exports go through an audited server check.
- SECURITY DEFINER functions detect trusted jobs with `is_service_request()` (`auth.role()`), because `current_user` is the definer inside them.
- Omie financial field mapping is documented in `docs/OMIE_FINANCIAL_MAPPING.md`; fields seen only in the legacy code stay marked unconfirmed until validated against the live API.
- Omie pipeline: every layer is keyed by company + source + external_id (items add sequence) with UNIQUE constraints, so re-ingesting is idempotent; one RUNNING sync per company+entity is enforced by a unique index.
- Omie readiness comes only from `omie_readiness()` (RAW proven by pagination + Canonical + Gold + no open high issues + fresh); a past success never means READY.
- Gold promotion (`promote_omie_gold`) runs only for real companies whose data_source is not DEMO, so demo data is never touched.
- Omie throttling lives only in `src/lib/omie/rate-limiter.ts` (425 opens a circuit per App Key+method; 429 backs off).
- Integrity divergences are recorded in `integrity_issues` and resolved only with justification + audit log; never auto-adjusted.
- Job base URL lives in `private.app_settings` (`set_app_base_url`); no preview/production URL in app code.
