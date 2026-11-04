from datetime import date, timedelta

import numpy as np

from biomie_intel.forecast import (INSUFFICIENT, MODELS, demand_class, forecast, last_week_end, origin_rates,
                                   weekly_series)

AS_OF = date(2026, 10, 23)  # sexta-feira: a última semana completa é a de 12 a 18/10
END = date(2026, 10, 18)
DAY = timedelta(days=1)


def sales_from_weeks(weekly, end=END):
    """Uma venda no domingo de cada semana (a última semana termina em end)."""
    n = len(weekly)
    return [(end - timedelta(days=7 * (n - 1 - i)), q) for i, q in enumerate(weekly) if q]


def run(weekly, available=5, is_new=False, weeks_of_history=None):
    weeks = weeks_of_history or len(weekly)
    sales_from = END - timedelta(days=7 * weeks - 1)  # uma segunda-feira
    m = {"stock": {"available": available}, "isNew": is_new}
    return forecast(m, sales_from_weeks(weekly), AS_OF, sales_from)


def without_day(f):
    """A previsão sem o que muda por definição com o dia da análise."""
    return {k: v for k, v in f.items() if k not in ("computedFor", "openWeek")}


def test_last_week_end_is_the_sunday_before_the_analysis_day():
    assert AS_OF.weekday() == 4 and last_week_end(AS_OF) == END
    assert last_week_end(date(2026, 10, 19)) == END  # segunda: a semana de ontem já está completa
    assert last_week_end(date(2026, 10, 25)) == END  # domingo: o próprio dia ainda não terminou às 06:33
    assert last_week_end(date(2026, 10, 26)) == date(2026, 10, 25)


def test_weekly_series_uses_calendar_weeks_and_leaves_the_current_week_out():
    sales = [(AS_OF, 7), (date(2026, 10, 19), 5),          # semana em curso (19 a 23/10): fora
             (END, 2), (date(2026, 10, 12), 1),              # domingo e segunda da última semana
             (date(2026, 10, 11), 4),                        # domingo da semana anterior
             (date(2026, 10, 1), 8), (date(2026, 1, 1), 9)]  # antes do início observado: fora
    y, first = weekly_series(sales, AS_OF, date(2026, 10, 1))  # quinta: 1º a 4/10 é semana parcial
    assert first == date(2026, 10, 5) and first.weekday() == 0
    assert list(y) == [4.0, 3.0]  # 5–11/10 e 12–18/10; a semana em curso fica de fora
    y, first = weekly_series(sales, AS_OF, None)
    assert len(y) == 0 and first is None
    y, first = weekly_series(sales, AS_OF, date(2026, 10, 13))  # ainda sem semana completa observada
    assert len(y) == 0 and first is None


def test_same_series_model_and_status_on_every_day_of_the_week():
    rng = np.random.default_rng(11)
    sales_from = date(2026, 1, 1)
    days = [sales_from + timedelta(days=int(d)) for d in rng.choice(320, size=40, replace=False)]
    sales = sorted((d, float(rng.integers(1, 6))) for d in days)
    m = {"stock": {"available": 3}, "isNew": False}
    monday = date(2026, 10, 26)
    results = []
    for k in range(7):  # segunda 26/10 a domingo 01/11, com vendas novas também na semana em curso
        as_of = monday + timedelta(days=k)
        known = [(d, q) for d, q in sales if d < as_of]  # às 06:33 o próprio dia ainda não tem venda
        new = [(monday + timedelta(days=j), 9.0) for j in range(k)]  # uma venda grande por dia da semana
        results.append(forecast(m, known + new, as_of, sales_from))
    assert results[0]["status"] == "ok"
    assert all(without_day(r) == without_day(results[0]) for r in results[1:])
    assert [r["openWeek"]["from"] for r in results] == ["2026-10-26"] * 7
    assert results[0]["trainTo"] == results[0]["series"]["weekEnd"] == "2026-10-25"
    # na segunda seguinte entra a semana que acabou de se completar
    nxt = forecast(m, [(d, q) for d, q in sales if d < monday + timedelta(days=7)], monday + timedelta(days=7),
                   sales_from)
    assert nxt["weeks"] == results[0]["weeks"] + 1 and nxt["trainTo"] == "2026-11-01"
    assert nxt["series"]["actual"][:-1] == results[0]["series"]["actual"][1:]


def test_two_close_sales_keep_the_status_from_one_day_to_the_next():
    """Caso real (Uni Design, cadeira 00121, 03 → 04/11): 3 vendas em 10 meses, duas com um dia de
    diferença. Com semanas que terminavam no dia da análise, as duas caíram juntas numa semana em 04/11
    e o status passou de 'ok' para 'insuficiente' sem venda nova; com semanas fixas, não muda."""
    m = {"stock": {"available": -3}, "isNew": False}
    for first_sale, expected in ((date(2026, 6, 16), "insuficiente"),  # terça e quarta: mesma semana
                                 (date(2026, 6, 14), "ok")):           # domingo e quarta: semanas diferentes
        sales = [(first_sale, 1.0), (date(2026, 6, 17), 1.0), (date(2026, 8, 14), 1.0)]
        statuses = {forecast(m, sales, date(2026, 11, d), date(2026, 1, 1))["status"] for d in range(2, 9)}
        assert statuses == {expected}, (first_sale, statuses)


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
