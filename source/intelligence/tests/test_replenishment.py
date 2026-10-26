import math

from test_engine import FakeClient
from test_metrics import PARAMS

from biomie_intel.engine import run
from biomie_intel.replenishment import TRANSFER_NOTE, index_entry, opportunities, plan, resolve_params

PARAMS_ROWS = [
    {"companyId": "c1", "scope": "empresa", "key": "", "leadTimeDays": 30},
    {"companyId": "c1", "scope": "familia", "key": "Cadeiras", "leadTimeDays": 20},
    {"companyId": "c1", "scope": "produto", "key": "7", "leadTimeDays": 14, "reviewDays": 30, "serviceLevel": 0.90},
    {"companyId": "c2", "scope": "empresa", "key": "", "leadTimeDays": 99},
]


def metrics(available=10, pending=5, min_qty=0, unit_cost=50.0, known=True, suspect=False, status="ok",
            daily=2.0, weekly_std=7.0, quality="regular"):
    return {"stock": {"available": available, "pending": pending, "minQty": min_qty, "qty": available},
            "cost": {"unitCost": unit_cost if known else None, "known": known, "suspect": suspect},
            "forecast": {"status": status, "dailyRate": daily, "weeklyStd": weekly_std, "model": "sba",
                         "backtest": {"quality": quality, "wape": 0.4}}}


def test_most_specific_parameter_wins_and_companies_do_not_mix():
    assert resolve_params(PARAMS_ROWS, "c1", "7", "Cadeiras")["leadTimeDays"] == 14
    assert resolve_params(PARAMS_ROWS, "c1", "8", "Cadeiras")["leadTimeDays"] == 20
    assert resolve_params(PARAMS_ROWS, "c1", "8", None)["leadTimeDays"] == 30
    assert resolve_params(PARAMS_ROWS, "c3", "7", "Cadeiras") is None


def test_no_lead_time_or_no_reliable_forecast_means_no_quantity():
    r = plan(metrics(), "saudavel", None)
    assert r["status"] == "sem_prazo" and "qty" not in r
    r = plan(metrics(status="insuficiente"), "saudavel", PARAMS_ROWS[2])
    assert r["status"] == "sem_previsao" and "qty" not in r
    assert plan(metrics(daily=0.0), "saudavel", PARAMS_ROWS[2])["status"] == "sem_demanda"


def test_buy_quantity_safety_stock_and_risk():
    r = plan(metrics(), "risco_ruptura", PARAMS_ROWS[2])
    safety = 1.28 * (7.0 / math.sqrt(7)) * math.sqrt(14)
    reorder = 2.0 * 14 + safety
    target = reorder + 2.0 * 30
    assert r["status"] == "comprar"
    assert r["safetyStock"] == round(safety, 2) and r["reorderPoint"] == round(reorder, 2)
    assert r["qty"] == math.ceil(target - 15) and r["costEstimate"] == round(r["qty"] * 50.0, 2)
    assert r["coverageDays"] == 7.5 and "menos que o prazo de reposição de 14 dias" in r["risk"]
    assert any("Lote mínimo" in x for x in r["limitations"])


def test_min_lot_omie_minimum_and_maximum_coverage():
    lot = plan(metrics(), "saudavel", {**PARAMS_ROWS[2], "minLot": 10})
    assert lot["qty"] % 10 == 0 and lot["qty"] >= 86
    high_min = plan(metrics(min_qty=60), "saudavel", PARAMS_ROWS[2])
    assert high_min["reorderPoint"] == 60 and high_min["reorderFromOmieMin"] is True
    capped = plan(metrics(), "saudavel", {**PARAMS_ROWS[2], "maxCoverageDays": 25})
    assert capped["target"] == 50.0  # 25 dias × 2 un./dia, abaixo do alvo sem limite
    floor = plan(metrics(), "saudavel", {**PARAMS_ROWS[2], "maxCoverageDays": 15})
    assert floor["target"] == floor["reorderPoint"]  # 15 × 2 = 30 < ponto de reposição: fica no ponto


def test_do_not_buy_and_wait():
    assert plan(metrics(available=500), "possivel_excesso", PARAMS_ROWS[2])["status"] == "nao_comprar"
    assert plan(metrics(available=60, pending=0), "saudavel", PARAMS_ROWS[2])["status"] == "aguardar"


def test_cost_estimate_needs_reliable_cost():
    r = plan(metrics(known=False), "risco_ruptura", PARAMS_ROWS[2])
    assert r["status"] == "comprar" and r["costEstimate"] is None
    assert any("Custo estimado indisponível" in x for x in r["limitations"])
    assert plan(metrics(suspect=True), "risco_ruptura", PARAMS_ROWS[2])["costEstimate"] is None


def row(omie, sku, state, available, daily, unit_cost=40.0, pending=0):
    return {"omieProductId": omie, "sku": sku, "name": f"Produto {sku}", "state": state,
            "metrics": {"stock": {"available": available, "pending": pending}, "daysWithoutSale": 200,
                        "cost": {"unitCost": unit_cost, "known": True, "suspect": False},
                        "forecast": {"status": "ok", "dailyRate": daily} if daily is not None else {"status": "insuficiente"}}}


def test_opportunity_between_companies_by_sku():
    c1, c2, c3 = ({"id": f"c{i}", "name": f"Empresa {i}"} for i in (1, 2, 3))
    entries = [index_entry(c1, row("10", "SKU-X", "possivel_excesso", 100, 0.1)),
               index_entry(c2, row("20", "SKU-X", "risco_ruptura", 0, 1.0)),
               index_entry(c3, row("30", "SKU-X", "saudavel", 50, 0.2)),        # nem sobra nem falta
               index_entry(c2, row("21", "SKU-Y", "risco_ruptura", 0, 1.0)),    # SKU só numa empresa
               index_entry(c1, row("40", "40", "possivel_excesso", 10, None))]  # SKU = código do Omie: fora
    entries = [e for e in entries if e]
    opps = opportunities(entries, 15)
    assert len(opps) == 1
    o = opps[0]
    assert (o["fromCompanyId"], o["toCompanyId"], o["qty"]) == ("c1", "c2", 90)  # sobra 91, falta 90
    assert o["valueAtCost"] == 90 * 40.0 and o["note"] == TRANSFER_NOTE and o["from"]["state"] == "possivel_excesso"


def test_opportunity_needs_forecast_and_never_pairs_a_company_with_itself():
    c1, c2 = ({"id": f"c{i}", "name": f"Empresa {i}"} for i in (1, 2))
    entries = [index_entry(c1, row("10", "SKU-X", "possivel_excesso", 100, 0.1)),
               index_entry(c2, row("20", "SKU-X", "risco_ruptura", 0, None))]   # sem previsão: sem necessidade
    assert opportunities([e for e in entries if e], 15) == []
    entries = [index_entry(c1, row("10", "SKU-X", "possivel_excesso", 100, 0.1)),
               index_entry(c1, row("11", "SKU-X", "risco_ruptura", 0, 1.0))]
    assert opportunities([e for e in entries if e], 15) == []


def test_engine_publishes_opportunities_only_in_full_runs():
    client = FakeClient()
    run(client, trigger="ops", log=lambda e: None)
    names = [n for n, _ in client.calls]
    assert names.index("stock_intel_planning") == 1
    pub = [a for n, a in client.calls if n == "stock_intel_publish_opportunities"]
    assert len(pub) == 1 and pub[0]["p_chunk"] == 0 and pub[0]["p_rows"] == []  # lote 0 limpa a execução
    assert names.index("stock_intel_publish_opportunities") < names.index("stock_intel_finish")
    client = FakeClient()
    run(client, trigger="ops", company="mag-filial", log=lambda e: None)
    assert "stock_intel_publish_opportunities" not in [n for n, _ in client.calls]
