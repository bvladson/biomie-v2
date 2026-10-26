"""Indicadores por produto a partir do retrato que o BIOMIE entrega (stock_intel_extract).

Regras gerais:
- valor desconhecido fica None, nunca zero: custo ausente, histórico que não cobre o período etc.;
- uma janela de N dias termina na data de referência (asOf) e inclui o próprio dia;
- "dias cobertos" = a parte da janela posterior ao início das vendas no BIOMIE (salesFrom); o que
  vem antes disso é desconhecido, não venda zero;
- vendas = a mesma base da página Produtos (fact_sales), por empresa; devoluções = entradas de
  devolução de venda (operação 13) nas movimentações do Omie.
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from typing import Any

import pandas as pd

WINDOWS = (30, 60, 90, 180, 365)
CURVE_RANK = {"A": 1, "B": 2, "C": 3, "D": 4}


def to_date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    return value if isinstance(value, date) else date.fromisoformat(str(value)[:10])


def to_float(value: Any) -> float | None:
    if value is None:
        return None
    number = float(value)
    return None if math.isnan(number) else number


def rnd(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(float(value), digits)


def covered_days(window: int, as_of: date, sales_from: date | None) -> int:
    """Quantos dias da janela têm vendas registradas no BIOMIE (0 = nenhum)."""
    if sales_from is None or sales_from > as_of:
        return 0
    first = max(as_of - timedelta(days=window - 1), sales_from)
    return (as_of - first).days + 1


def sales_frame(rows: list[list[Any]] | None) -> pd.DataFrame:
    frame = pd.DataFrame(rows or [], columns=["omie", "day", "qty", "revenue", "invoices"])
    if not frame.empty:
        frame["day"] = pd.to_datetime(frame["day"]).dt.date
        for column in ("qty", "revenue", "invoices"):
            frame[column] = pd.to_numeric(frame[column])
    return frame


def window_sums(frame: pd.DataFrame, as_of: date) -> dict[str, dict[Any, Any]]:
    """Por produto: {N: (unidades, faturamento, notas)} de cada janela e 'prev60' (dias 61 a 120)."""
    out: dict[str, dict[Any, Any]] = {}
    if frame.empty:
        return out
    for window in WINDOWS:
        start = as_of - timedelta(days=window - 1)
        part = frame[(frame["day"] >= start) & (frame["day"] <= as_of)]
        grouped = part.groupby("omie")[["qty", "revenue", "invoices"]].sum()
        for omie, row in grouped.iterrows():
            out.setdefault(str(omie), {})[window] = (float(row["qty"]), float(row["revenue"]), int(row["invoices"]))
    prev = frame[(frame["day"] >= as_of - timedelta(days=119)) & (frame["day"] <= as_of - timedelta(days=60))]
    for omie, qty in prev.groupby("omie")["qty"].sum().items():
        out.setdefault(str(omie), {})["prev60"] = float(qty)
    return out


def month_list(as_of: date, sales_from: date | None) -> list[str]:
    """Meses com vendas registradas dentro dos últimos 12 meses (o primeiro e o atual podem ser parciais)."""
    if sales_from is None or sales_from > as_of:
        return []
    first = max(sales_from, as_of - timedelta(days=364))
    return [str(p) for p in pd.period_range(first, as_of, freq="M")]


def monthly_series(frame: pd.DataFrame, months: list[str]) -> dict[str, dict[str, tuple[float, float]]]:
    out: dict[str, dict[str, tuple[float, float]]] = {}
    if frame.empty or not months:
        return out
    data = frame.assign(month=pd.to_datetime(frame["day"]).dt.to_period("M").astype(str))
    data = data[data["month"].isin(months)]
    for (omie, month), row in data.groupby(["omie", "month"])[["qty", "revenue"]].sum().iterrows():
        out.setdefault(str(omie), {})[month] = (float(row["qty"]), float(row["revenue"]))
    return out


def returns_by_product(rows: list[list[Any]] | None) -> dict[str, tuple[float, int]]:
    out: dict[str, tuple[float, int]] = {}
    for omie, _day, qty in rows or []:
        units, events = out.get(str(omie), (0.0, 0))
        out[str(omie)] = (units + float(qty), events + 1)
    return out


def curve_history(rows: list[list[Any]] | None) -> dict[str, list[tuple[str, date]]]:
    """Por produto, as mudanças de curva mais recentes primeiro: [(curva, dia), ...]."""
    out: dict[str, list[tuple[str, date]]] = {}
    for omie, curve, day in rows or []:
        out.setdefault(str(omie), []).append((str(curve), to_date(day)))
    for items in out.values():
        items.sort(key=lambda item: item[1], reverse=True)
    return out


def product_metrics(
    product: dict[str, Any],
    sums: dict[Any, Any],
    series: dict[str, tuple[float, float]],
    months: list[str],
    returns: tuple[float, int] | None,
    history: list[tuple[str, date]] | None,
    as_of: date,
    sales_from: date | None,
    params: dict[str, Any],
) -> dict[str, Any]:
    qty = to_float(product.get("qty")) or 0.0
    reserved = to_float(product.get("reserved")) or 0.0
    available = qty - reserved
    qty_positive = to_float(product.get("qtyPositive")) or 0.0
    cost = to_float(product.get("costMax"))
    cost_min = to_float(product.get("costMin"))
    cost_known = cost is not None and cost > 0
    cost_suspect = cost_known and cost <= float(params["costSuspectMax"])
    capital = to_float(product.get("capital"))
    if qty_positive > 0 and not cost_known:
        capital = None

    sales: dict[str, dict[str, Any]] = {}
    for window in WINDOWS:
        units, revenue, invoices = sums.get(window, (0.0, 0.0, 0))
        covered = covered_days(window, as_of, sales_from)
        sales[f"d{window}"] = {
            "units": rnd(units, 3) if covered else None,
            "revenue": rnd(revenue) if covered else None,
            "invoices": invoices if covered else None,
            "coveredDays": covered,
        }
    cov90, cov365 = covered_days(90, as_of, sales_from), covered_days(365, as_of, sales_from)
    units90 = sums.get(90, (0.0, 0.0, 0))[0]
    units365, revenue365 = sums.get(365, (0.0, 0.0, 0))[:2]

    # Velocidade (unidades por dia): 90 dias quando houve venda neles, senão os dias cobertos do ano.
    if cov90 >= 30 and units90 > 0:
        velocity, basis = units90 / cov90, "90d"
    elif cov365 >= 30:
        velocity, basis = units365 / cov365, "365d"
    else:
        velocity, basis = None, None

    if available <= 0:
        coverage = 0.0 if velocity is not None else None
    elif velocity:
        coverage = available / velocity
    else:
        coverage = None  # sem consumo observado: cobertura indeterminada (não "infinita")

    min_history = int(params["minHistoryDays"])
    turnover = None
    if qty_positive > 0 and cov365 >= min_history:
        turnover = (units365 / cov365 * 365) / qty_positive

    trend, prev60_units = None, None
    prev60 = sums.get("prev60", 0.0)
    if covered_days(120, as_of, sales_from) >= 120:
        prev60_units = prev60
    if covered_days(120, as_of, sales_from) >= 120 and prev60 > 0:
        last60 = sums.get(60, (0.0, 0.0, 0))[0]
        trend = (last60 - prev60) / prev60 * 100

    avg_price = revenue365 / units365 if units365 > 0 and revenue365 > 0 else None
    margin = None
    if avg_price and cost_known and not cost_suspect:
        margin = (avg_price - cost) / avg_price * 100

    current = product.get("curve")
    previous, changed_on = None, None
    if history:
        changed_on = history[0][1] if history[0][0] == current else None
        older = [curve for curve, _day in history if curve != current]
        previous = older[0] if older else None
    worsened = bool(previous and current in CURVE_RANK and CURVE_RANK[current] > CURVE_RANK.get(previous, 0))

    return {
        "stock": {
            "qty": rnd(qty, 3), "available": rnd(available, 3), "reserved": rnd(reserved, 3),
            "pending": rnd(to_float(product.get("pending")), 3), "minQty": rnd(to_float(product.get("minQty")), 3),
            "locations": product.get("locations"), "negativePositions": product.get("negativePositions") or 0,
            "negativeValue": rnd(to_float(product.get("negativeValue"))),
        },
        "cost": {"unitCost": rnd(cost, 4) if cost_known else None, "known": cost_known, "suspect": cost_suspect,
                 "divergentLocations": bool(cost_known and cost_min is not None and abs(cost - cost_min) > 0.005),
                 "minUnitCost": rnd(cost_min, 4) if cost_known and cost_min is not None else None,
                 "prevUnitCost": rnd(to_float(product.get("prevUnitCost")), 4)},
        "capital": rnd(capital),
        "salePrice": rnd(to_float(product.get("salePrice"))),
        "sales": sales,
        "velocityDaily": rnd(velocity, 4), "velocityBasis": basis,
        "coverageDays": rnd(coverage, 1),
        "turnoverAnnual": rnd(turnover, 2),
        "trend60Pct": rnd(trend, 1), "prev60Units": rnd(prev60_units, 3),
        "received30": rnd(to_float(product.get("received30")), 3),
        "received90": rnd(to_float(product.get("received90")), 3),
        "avgPrice": rnd(avg_price),
        "marginEstPct": rnd(margin, 1),
        "returns365": {"units": rnd(returns[0], 3), "events": returns[1]} if returns else {"units": 0, "events": 0},
        "lastSale": product.get("lastSale"), "daysWithoutSale": product.get("daysWithoutSale"),
        "idleSince": product.get("idleSince"),
        "lastEntry": product.get("lastEntry"), "lastEntryOperation": product.get("lastEntryOperation"),
        "lastExit": product.get("lastExit"), "lastExitOperation": product.get("lastExitOperation"),
        "lastExitGroup": bool(product.get("lastExitGroup")), "recentExit": bool(product.get("recentExit")),
        "arrivedOn": product.get("arrivedOn"), "registeredAt": product.get("registeredAt"),
        "isNew": bool(product.get("isNew")), "incompleteReason": product.get("incompleteReason"),
        "elsewhereCompany": product.get("elsewhereCompany"), "elsewhereLastSale": product.get("elsewhereLastSale"),
        "curve": {"current": current, "source": product.get("curveSource"), "previous": previous,
                  "changedOn": changed_on.isoformat() if changed_on else None, "worsened": worsened,
                  "revenue12m": rnd(to_float(product.get("revenue12m"))),
                  "share12m": rnd(to_float(product.get("share12m")), 6),
                  # janela da curva = a desta análise (mesmo fim): só então o faturamento é comparável
                  "windowAligned": (to_date(product.get("curveWindowStart")) == as_of - timedelta(days=364))
                  if product.get("curveWindowStart") else None},
        "salesMonthly": [[m, rnd(series.get(m, (0.0, 0.0))[0], 3), rnd(series.get(m, (0.0, 0.0))[1])]
                         for m in months],
        "historyCoveredDays": cov365,
    }
