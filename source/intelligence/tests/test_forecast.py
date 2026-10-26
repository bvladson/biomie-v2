from datetime import date, timedelta

import numpy as np

from biomie_intel.forecast import (INSUFFICIENT, MODELS, demand_class, forecast, origin_rates, weekly_series)

AS_OF = date(2026, 10, 23)


def sales_from_weeks(weekly, as_of=AS_OF):
    """Uma venda no último dia de cada semana (a última semana termina em as_of)."""
    n = len(weekly)
    return [(as_of - timedelta(days=7 * (n - 1 - i)), q) for i, q in enumerate(weekly) if q]


def run(weekly, available=5, is_new=False, weeks_of_history=None):
    weeks = weeks_of_history or len(weekly)
    sales_from = AS_OF - timedelta(days=7 * weeks - 1)
    m = {"stock": {"available": available}, "isNew": is_new}
    return forecast(m, sales_from_weeks(weekly), AS_OF, sales_from)


def test_weekly_series_uses_only_complete_observed_weeks():
    sales = [(AS_OF, 2), (AS_OF - timedelta(days=6), 1), (AS_OF - timedelta(days=7), 4), (date(2026, 1, 1), 9)]
    y, first = weekly_series(sales, AS_OF, date(2026, 10, 1))  # 23 dias = 3 semanas completas
    assert list(y) == [0.0, 4.0, 3.0] and first == AS_OF - timedelta(days=20)
    y, first = weekly_series(sales, AS_OF, None)
    assert len(y) == 0 and first is None


def test_no_temporal_leakage_in_any_model():
    rng = np.random.default_rng(7)
    y = rng.poisson(1.5, 40).astype(float)
    rates = origin_rates(y)
    for cut in (10, 20, 30):
        changed = y.copy()
        changed[cut:] = changed[cut:] * 10 + 50  # o futuro muda completamente
        other = origin_rates(changed)
        for name in MODELS:
            assert np.allclose(rates[name][1:cut + 1], other[name][1:cut + 1], equal_nan=True), name


def test_reproducible():
    weekly = [0, 3, 0, 0, 5, 1, 0, 2, 0, 0, 4, 0, 1, 0, 3, 0, 0, 2, 6, 0, 0, 1, 0, 2, 0, 3, 0, 1, 2, 0]
    assert run(weekly) == run(weekly)


def test_constant_demand_is_forecast_exactly_by_the_simplest_model():
    f = run([2.0] * 40)
    assert f["status"] == "ok" and f["model"] == "media_13s" and f["demandClass"] == "frequente"
    assert f["horizons"]["30"]["units"] == round(2 * 30 / 7, 2)
    assert f["backtest"]["wape"] == 0 and f["backtest"]["quality"] == "boa"
    assert f["horizons"]["30"]["low"] == f["horizons"]["30"]["high"] == f["horizons"]["30"]["units"]
    assert f["horizons"]["90"]["units"] == round(2 * 90 / 7, 2)


def test_intermittent_series_is_classified_and_has_finite_metrics():
    weekly = [0, 0, 6] * 13  # 39 semanas, 13 com venda: ADI = 3
    f = run(weekly)
    assert f["status"] == "ok" and f["demandClass"] == "intermitente" and f["adi"] == 3.0
    assert 1.5 <= f["weeklyRate"] <= 2.5
    for value in (f["backtest"]["mae"], f["backtest"]["wape"], f["backtest"]["bias"]):
        assert value is not None and np.isfinite(value)
    assert set(f["backtest"]["models"]) == set(MODELS)


def test_no_forecast_without_enough_data():
    assert run([1] * 11)["message"] == INSUFFICIENT and run([1] * 11)["status"] == "insuficiente"
    assert run([0] * 30)["status"] == "sem_vendas"
    assert run([3] * 10 + [0] * 26)["status"] == "sem_vendas_prolongadas"
    assert run([0] * 28 + [1, 1])["status"] == "insuficiente"  # só 2 semanas com venda
    assert run([1] * 30, is_new=True)["status"] == "novo"
    stopped = run([1] * 11)
    assert "horizons" not in stopped and "model" not in stopped  # nada inventado para encher o gráfico


def test_interval_only_with_ten_backtest_cuts():
    assert "low" not in run([1, 2] * 10)["horizons"]["30"]  # 20 semanas = 9 cortes
    f = run([1, 2] * 15)
    assert "low" in f["horizons"]["30"] and f["intervalBasis"] is not None
    assert f["horizons"]["30"]["low"] <= f["horizons"]["30"]["units"] <= f["horizons"]["30"]["high"]


def test_out_of_stock_warns_repressed_demand():
    f = run([2.0] * 40, available=0)
    assert any("reprimida" in item for item in f["limitations"])


def test_chart_series_aligns_actual_and_one_step_forecasts():
    weekly = list(range(1, 41))
    f = run(weekly)
    actual, fitted = f["series"]["actual"], f["series"]["fitted"]
    assert len(actual) == len(fitted) == 26 and actual[-1] == 40
    assert all(v is not None for v in fitted)


def test_demand_class_thresholds():
    assert demand_class(np.array([1.0] * 10))[0] == "frequente"
    assert demand_class(np.array([1.0, 9.0] * 5))[0] == "irregular"
    assert demand_class(np.array([0.0, 0.0, 9.0, 0.0, 0.0, 1.0]))[0] == "esporadica"
    assert demand_class(np.zeros(5)) == (None, None, None)
