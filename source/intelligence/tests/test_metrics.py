from datetime import date

from biomie_intel.metrics import (covered_days, curve_history, month_list, monthly_series, product_metrics,
                                  sales_frame, window_sums)

PARAMS = {"minHistoryDays": 120, "lowTurnoverAnnual": 1.0, "excessCoverageDays": 180, "obsolescenceDays": 365,
          "ruptureCoverageDays": 15, "trendDeclinePct": -30, "costSuspectMax": 1.0, "runsKeptDays": 14,
          "priorityWeights": {"capital": 0.4, "idle": 0.3, "coverage": 0.15, "trend": 0.15}}
AS_OF = date(2026, 10, 23)
SALES_FROM = date(2026, 1, 1)


def base_product(**over):
    p = {"omieProductId": "1", "qty": 10, "reserved": 0, "pending": 0, "minQty": 0, "costMax": 50, "costMin": 50,
         "qtyPositive": 10, "capital": 500, "negativeValue": None, "negativePositions": 0, "locations": 1,
         "salePrice": 120, "curve": "C", "curveSource": "auto", "revenue12m": 300, "share12m": 0.01,
         "lastSale": "2026-10-01", "daysWithoutSale": 22, "isNew": False, "incompleteReason": None}
    p.update(over)
    return p


def metrics_for(rows, product=None, history=None, sales_from=SALES_FROM):
    frame = sales_frame(rows)
    sums = window_sums(frame, AS_OF)
    months = month_list(AS_OF, sales_from)
    series = monthly_series(frame, months)
    return product_metrics(product or base_product(), sums.get("1", {}), series.get("1", {}), months, None,
                           history, AS_OF, sales_from, PARAMS)


def test_covered_days_counts_only_days_with_sales_history():
    assert covered_days(30, AS_OF, SALES_FROM) == 30
    assert covered_days(365, AS_OF, SALES_FROM) == (AS_OF - SALES_FROM).days + 1
    assert covered_days(90, AS_OF, None) == 0
    assert covered_days(30, AS_OF, date(2026, 10, 20)) == 4


def test_windows_include_the_reference_day_and_exclude_older_days():
    rows = [["1", "2026-10-23", 2, 200, 1], ["1", "2026-09-24", 1, 100, 1], ["1", "2026-09-23", 5, 500, 1]]
    sums = window_sums(sales_frame(rows), AS_OF)["1"]
    assert sums[30] == (3.0, 300.0, 2)  # 24/09 entra (30 dias com hoje), 23/09 não
    assert sums[60][0] == 8.0


def test_unknown_cost_is_none_never_zero():
    m = metrics_for([["1", "2026-10-01", 1, 120, 1]], base_product(costMax=None, costMin=None, capital=None))
    assert m["capital"] is None
    assert m["cost"]["unitCost"] is None and not m["cost"]["known"]
    assert m["marginEstPct"] is None


def test_suspect_cost_keeps_capital_but_suppresses_margin():
    m = metrics_for([["1", "2026-10-01", 1, 120, 1]], base_product(costMax=0.5, costMin=0.5, capital=5))
    assert m["cost"]["suspect"] and m["capital"] == 5.0 and m["marginEstPct"] is None


def test_velocity_coverage_turnover_and_margin():
    rows = [["1", "2026-10-10", 9, 900, 3]]  # 9 unidades em 90 dias = 0,1/dia
    m = metrics_for(rows)
    assert m["velocityBasis"] == "90d" and m["velocityDaily"] == 0.1
    assert m["coverageDays"] == 100.0  # 10 em estoque ÷ 0,1 por dia
    covered = (AS_OF - SALES_FROM).days + 1
    assert m["turnoverAnnual"] == round((9 / covered * 365) / 10, 2)
    assert m["avgPrice"] == 100.0 and m["marginEstPct"] == 50.0


def test_no_consumption_leaves_coverage_undetermined_not_infinite():
    m = metrics_for([])
    assert m["velocityDaily"] == 0.0 and m["coverageDays"] is None


def test_windows_before_sales_history_are_unknown():
    m = metrics_for([], sales_from=None)
    assert m["sales"]["d90"]["units"] is None and m["velocityDaily"] is None and m["coverageDays"] is None


def test_trend_compares_last_60_days_with_previous_60():
    rows = [["1", "2026-10-01", 2, 200, 1], ["1", "2026-07-30", 8, 800, 1]]
    m = metrics_for(rows)
    assert m["trend60Pct"] == -75.0


def test_monthly_series_has_explicit_zeros_and_no_months_before_history():
    rows = [["1", "2026-03-15", 2, 200, 1]]
    m = metrics_for(rows, sales_from=date(2026, 2, 10))
    months = [entry[0] for entry in m["salesMonthly"]]
    assert months[0] == "2026-02" and months[-1] == "2026-10"
    assert ["2026-03", 2.0, 200.0] in m["salesMonthly"] and ["2026-04", 0.0, 0.0] in m["salesMonthly"]


def test_curve_history_marks_worsening():
    history = curve_history([["1", "C", "2026-10-22"], ["1", "A", "2026-10-01"]])["1"]
    m = metrics_for([], base_product(curve="C"), history)
    assert m["curve"]["previous"] == "A" and m["curve"]["worsened"] and m["curve"]["changedOn"] == "2026-10-22"
