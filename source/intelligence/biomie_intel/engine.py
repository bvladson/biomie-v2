"""Uma execução do motor: uma por vez, empresa a empresa, publicada só quando termina inteira.

Falha em qualquer empresa marca a execução como falha e apaga o que ela gravou; a tela continua
vendo a execução anterior. O motor nunca chama o Omie nem altera dados oficiais.
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable

import pandas as pd

from . import VERSION
from .api import RpcClient, RpcError
from .diagnosis import detect_alerts, diagnose, recommend
from .forecast import forecast
from .replenishment import buy_recommendation, index_entry, opportunities, plan, resolve_params
from .metrics import (curve_history, month_list, monthly_series, product_metrics, returns_by_product,
                      sales_frame, to_date, window_sums)
from .states import classify, priority

CHUNK = 200  # ~0,7 MB por lote com diagnósticos e previsão (gateway interno aceita 8 MB)


def build_company_rows(extract: dict[str, Any], params: dict[str, Any],
                       replenishment: list[dict[str, Any]] | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    as_of = to_date(extract["asOf"])
    sales_from = to_date(extract.get("salesFrom"))
    frame = sales_frame(extract.get("sales"))
    sums = window_sums(frame, as_of)
    months = month_list(as_of, sales_from)
    series = monthly_series(frame, months)
    returns = returns_by_product(extract.get("returns"))
    history = curve_history(extract.get("curveHistory"))
    daily: dict[str, list[Any]] = {}
    if not frame.empty:
        for omie, part in frame.groupby("omie"):
            daily[str(omie)] = list(zip(part["day"], part["qty"]))

    items = []
    for product in extract.get("products") or []:
        omie = str(product["omieProductId"])
        m = product_metrics(product, sums.get(omie, {}), series.get(omie, {}), months, returns.get(omie),
                            history.get(omie), as_of, sales_from, params)
        state, flags = classify(m, params)
        items.append((product, m, state, flags))

    capitals = pd.Series({i: m["capital"] for i, (_p, m, _s, _f) in enumerate(items)
                          if (m["stock"]["qty"] or 0) > 0 and m["capital"] is not None}, dtype=float)
    pct = capitals.rank(pct=True, method="average").to_dict() if not capitals.empty else {}

    rows: list[dict[str, Any]] = []
    by_state: dict[str, dict[str, Any]] = {}
    alerts_by_severity: dict[str, int] = {}
    forecasts: dict[str, int] = {}
    buying: dict[str, int] = {}
    company_id = str(extract.get("companyId"))
    for i, (product, m, state, flags) in enumerate(items):
        score, parts = priority(m, state, pct.get(i), params)
        m["diagnoses"] = diagnose(m, state, flags, params)
        m["recommendations"] = recommend(m, state, flags, m["diagnoses"], params)
        m["alerts"] = detect_alerts(m, state, flags, params)
        m["forecast"] = forecast(m, daily.get(str(product["omieProductId"]), []), as_of, sales_from)
        key = m["forecast"]["status"] if m["forecast"]["status"] != "ok" else f"ok_{m['forecast']['backtest']['quality']}"
        forecasts[key] = forecasts.get(key, 0) + 1
        omie = str(product["omieProductId"])
        m["replenishment"] = plan(m, state, resolve_params(replenishment or [], company_id, omie, product.get("family")))
        buy = buy_recommendation(m["replenishment"])
        if buy:
            m["recommendations"].insert(0, buy)
        buying[m["replenishment"]["status"]] = buying.get(m["replenishment"]["status"], 0) + 1
        for alert in m["alerts"]:
            alerts_by_severity[alert["severity"]] = alerts_by_severity.get(alert["severity"], 0) + 1
        rows.append({"omieProductId": str(product["omieProductId"]), "productId": product.get("productId"),
                     "sku": product.get("sku"), "name": product.get("name"), "family": product.get("family"),
                     "state": state, "flags": flags, "priority": score, "priorityParts": parts, "metrics": m})
        bucket = by_state.setdefault(state, {"products": 0, "capital": 0.0})
        bucket["products"] += 1
        bucket["capital"] = round(bucket["capital"] + (m["capital"] or 0.0), 2)
    stats = {
        "products": len(rows),
        "withStock": sum(1 for _p, m, _s, _f in items if (m["stock"]["qty"] or 0) > 0),
        "unknownCost": sum(1 for _p, _m, _s, f in items if "custo_desconhecido" in f),
        "byState": by_state,
        "alerts": alerts_by_severity,
        "forecasts": forecasts,
        "replenishment": buying,
        "asOf": extract["asOf"], "salesFrom": extract.get("salesFrom"),
    }
    return rows, stats


def _log(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def run(client: RpcClient, trigger: str = "schedule", force: bool = False, company: str | None = None,
        max_seconds: float = 1200.0, log: Callable[[dict[str, Any]], None] = _log,
        clock: Callable[[], float] = time.monotonic) -> dict[str, Any]:
    started = clock()
    begin = client.call("stock_intel_begin", {"p_trigger": trigger, "p_version": VERSION, "p_force": force},
                        retry=False)
    if not begin or not begin.get("started"):
        reason = (begin or {}).get("reason")
        log({"event": "intel_skipped", "reason": reason})
        return {"started": False, "reason": reason}
    run_id, params = begin["runId"], begin["params"]
    companies = [c for c in begin.get("companies") or [] if company in (None, c["id"], c["slug"])]
    summary: dict[str, Any] = {}
    entries: list[dict[str, Any]] = []
    try:
        if company and not companies:
            raise ValueError("Empresa não encontrada para a execução.")
        planning = client.call("stock_intel_planning", {"p_run": run_id}) or {}
        for item in companies:
            t0 = clock()
            extract = client.call("stock_intel_extract", {"p_run": run_id, "p_company": item["id"]})
            rows, stats = build_company_rows(extract, params, planning.get("replenishment") or [])
            entries.extend(e for e in (index_entry(item, r) for r in rows) if e is not None)
            for start in range(0, max(len(rows), 1), CHUNK):
                client.call("stock_intel_publish", {"p_run": run_id, "p_company": item["id"],
                                                    "p_chunk": start // CHUNK, "p_rows": rows[start:start + CHUNK]})
            stats["seconds"] = round(clock() - t0, 1)
            summary[item["slug"]] = stats
            log({"event": "intel_company", "company": item["slug"], "products": stats["products"],
                 "seconds": stats["seconds"]})
            if clock() - started > max_seconds:
                raise TimeoutError("Tempo máximo da execução esgotado.")
        # Oportunidades entre empresas só numa execução com todas as empresas (comparar exige as duas).
        opps = opportunities(entries, float(params["ruptureCoverageDays"])) if company is None else []
        if company is None:
            for start in range(0, max(len(opps), 1), 1000):
                client.call("stock_intel_publish_opportunities", {"p_run": run_id, "p_chunk": start // 1000,
                                                                 "p_rows": opps[start:start + 1000]})
        total = round(clock() - started, 1)
        finish = client.call("stock_intel_finish", {"p_run": run_id, "p_stats": {
            "version": VERSION, "seconds": total, "companies": summary, "opportunities": len(opps)}}, retry=False)
        log({"event": "intel_published", "runId": run_id, "companies": (finish or {}).get("companies"),
             "seconds": total})
        return {"started": True, "runId": run_id, "published": True, "seconds": total, "companies": summary}
    except Exception as error:  # noqa: BLE001 - qualquer falha encerra a execução sem publicar
        message = client.redact(f"{type(error).__name__}: {error}")[:300]
        try:
            client.call("stock_intel_fail", {"p_run": run_id, "p_error": message}, retry=False)
        except RpcError:
            pass
        log({"event": "intel_failed", "runId": run_id, "error": message})
        raise
