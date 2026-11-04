## Rules

- Flight Plan formulas live only in `src/domain/flight-plan/engine.ts` (FlightPlanEngine); `flight_plan_v2_dataset()` returns raw facts only, so math stays unit-tested in one place. The prototype simulator (`src/flight-plan/mock`) re-exports this engine instead of having its own.
- Working days are weighted: Mon–Fri 1, Saturday = company weight (`saturdayWeights` by slug in `metric_config.flight_plan`), Sunday and holidays 0.
- Flight Plan thresholds, active target level and forecast weights are read from `metric_config` key `flight_plan` and merged over `DEFAULT_FLIGHT_PLAN_CONFIG` — never hard-coded in components.
- Open-order forecast weights live only in `src/domain/flight-plan/order-weight.ts` (OrderWeightModel): expected date already passed = late (`lateOrderWeight`), expected after the period = 0 for the period, otherwise by age. Quotes (Omie stage 10) are never weighted. SQL returns raw open orders (age, expected date).
- Comparison windows (previous period, last year same cut, trailing 3/12m) come only from `src/domain/comparison.ts` (PeriodComparisonService).
