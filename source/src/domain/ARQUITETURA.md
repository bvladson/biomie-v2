## Rules

- Flight Plan formulas live only in `src/domain/flight-plan/engine.ts` (FlightPlanEngine); `flight_plan_dataset()` returns raw facts only, so math stays unit-tested in one place.
- Flight Plan thresholds, active target level and forecast weights are read from `metric_config` key `flight_plan` and merged over `DEFAULT_FLIGHT_PLAN_CONFIG` — never hard-coded in components.
- Open-order forecast weights live only in `src/domain/flight-plan/order-weight.ts` (OrderWeightModel); SQL returns raw open orders (age, expected date), so future Omie fields plug in there.
- Comparison windows (previous period, last year same cut, trailing 3/12m) come only from `src/domain/comparison.ts` (PeriodComparisonService).
