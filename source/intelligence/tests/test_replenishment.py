import math

from test_engine import FakeClient
from test_metrics import PARAMS

from biomie_intel.engine import run
from biomie_intel.replenishment import (TEST_NOTE, TRANSFER_NOTE, buy_recommendation, index_entry, index_planning,
                                        opportunities, plan, resolve_supply)

# Empresa com 4 fornecedores: 9001 (padrão 30 dias; 14 dias para o produto 7, lote 10), 9002 (45 dias), 9003
# (sem prazo) e 9004 (prazo de teste, só homologação).
PLANNING = {
    "policy": None,
    "suppliers": {"9001": "Alfa", "9002": "Beta", "9003": "Gama", "9004": "Delta"},
    "links": [["7", "9001"], ["8", "9001"], ["8", "9002"], ["9", "9003"], ["10", "9002"], ["10", "9003"],
              ["11", "9001"], ["11", "9002"], ["12", "9004"], ["13", "9003"], ["13", "9001"]],
    "leadTimes": [{"supplierId": "9001", "omie": "", "days": 30, "minLot": None, "status": "confirmado"},
                  {"supplierId": "9001", "omie": "7", "days": 14, "minLot": 10, "status": "confirmado"},
                  {"supplierId": "9002", "omie": "", "days": 45, "minLot": None, "status": "confirmado"},
                  {"supplierId": "9004", "omie": "", "days": 30, "minLot": None, "status": "teste"}],
    "preferred": {"11": "9002", "13": "9003", "99": "9001"},
}
IDX = index_planning(PLANNING)


def metrics(available=10, pending=5, min_qty=0, unit_cost=50.0, known=True, suspect=False, status="ok",
            daily=2.0, weekly_std=7.0, quality="regular", curve=None):
    return {"stock": {"available": available, "pending": pending, "minQty": min_qty, "qty": available},
            "curve": {"current": curve},
            "cost": {"unitCost": unit_cost if known else None, "known": known, "suspect": suspect},
            "forecast": {"status": status, "dailyRate": daily, "weeklyStd": weekly_std, "model": "sba",
                         "backtest": {"quality": quality, "wape": 0.4}}}


def supply(lead=14, lot=None, status="confirmado", source="produto"):
    """Fornecedor já escolhido, para testar só a conta."""
    return {"status": "ok", "notes": [], "suppliers": [],
            "supplier": {"id": "9001", "name": "Alfa", "leadTimeDays": lead, "leadTimeSource": source,
                         "leadTimeStatus": status, "minLot": lot, "choice": "unico"}}


def test_supplier_choice_principal_single_or_single_with_lead_time():
    s = resolve_supply(IDX, "7")      # um fornecedor: o prazo do produto prevalece sobre o padrão
    assert s["status"] == "ok" and s["supplier"]["leadTimeDays"] == 14 and s["supplier"]["leadTimeSource"] == "produto"
    assert s["supplier"]["minLot"] == 10 and s["supplier"]["choice"] == "unico"
    assert resolve_supply(IDX, "8")["status"] == "fornecedor_indefinido"   # dois com prazo, nenhum principal
    s = resolve_supply(IDX, "10")     # dois vinculados, só um com prazo
    assert s["status"] == "ok" and s["supplier"]["id"] == "9002" and s["supplier"]["choice"] == "unico_com_prazo"
    s = resolve_supply(IDX, "11")     # principal definido por Compras
    assert s["supplier"]["id"] == "9002" and s["supplier"]["choice"] == "principal" and s["supplier"]["leadTimeDays"] == 45
    s = resolve_supply(IDX, "13")     # principal sem prazo: não usa o prazo do outro fornecedor
    assert s["status"] == "sem_prazo" and s["supplier"]["id"] == "9003"
    assert resolve_supply(IDX, "9")["status"] == "sem_prazo" and resolve_supply(IDX, "9")["supplier"]["name"] == "Gama"
    assert resolve_supply(IDX, "99")["status"] == "sem_fornecedor"            # principal sem vínculo não vale
    assert resolve_supply(index_planning(None), "7")["status"] == "sem_fornecedor"


def test_without_supplier_lead_time_or_forecast_there_is_no_quantity():
    for omie, status in (("99", "sem_fornecedor"), ("8", "fornecedor_indefinido"), ("9", "sem_prazo")):
        r = plan(metrics(), "risco_ruptura", resolve_supply(IDX, omie))
        assert r["status"] == status and "qty" not in r and "indisponível" in r["message"]
    message = plan(metrics(), "saudavel", resolve_supply(IDX, "8"))["message"]
    assert "2 fornecedores com prazo informado (de 30 a 45 dias)" in message and "Alfa" not in message
    assert "do fornecedor principal" in plan(metrics(), "saudavel", resolve_supply(IDX, "13"))["message"]
    r = plan(metrics(status="insuficiente"), "saudavel", supply())
    assert r["status"] == "sem_previsao" and "qty" not in r
    assert plan(metrics(daily=0.0), "saudavel", supply())["status"] == "sem_demanda"
    assert plan(metrics(), "saudavel", None)["status"] == "sem_fornecedor"


def test_buy_quantity_safety_stock_and_risk():
    r = plan(metrics(), "risco_ruptura", supply())
    safety = 1.28 * (7.0 / math.sqrt(7)) * math.sqrt(14)
    reorder = 2.0 * 14 + safety
    target = reorder + 2.0 * 30
    assert r["status"] == "comprar" and r["supplier"]["name"] == "Alfa" and r["policySource"] == "padrao"
    assert r["safetyStock"] == round(safety, 2) and r["reorderPoint"] == round(reorder, 2)
    assert r["qty"] == math.ceil(target - 15) and r["costEstimate"] == round(r["qty"] * 50.0, 2)
    assert r["coverageDays"] == 7.5 and "menos que o prazo de entrega de 14 dias" in r["risk"]
    assert any("Lote mínimo" in x for x in r["limitations"]) and any("padrão do BIOMIE" in x for x in r["limitations"])
    assert buy_recommendation(r)["action"] == f"Comprar {r['qty']} un. (sugestão para revisão)"
    # O nome do fornecedor só no campo estruturado (o banco o tira para o Comercial), nunca nos textos.
    texts = " ".join([r["explanation"], r["risk"], *r["limitations"], *(e["label"] for e in r["evidence"])])
    assert r["supplier"]["name"] == "Alfa" and "Alfa" not in texts


def test_company_policy_lot_omie_minimum_and_maximum_coverage():
    policy = {"reviewDays": 15, "serviceLevels": {"A": 0.99, "B": 0.95, "C": 0.90, "D": 0.80, "U": 0.95},
              "maxCoverageDays": None}
    r = plan(metrics(), "saudavel", supply(), policy)
    assert r["policySource"] == "compras" and r["reviewDays"] == 15 and r["serviceLevel"] == 0.95
    assert r["serviceLevelCurve"] == "U"
    assert r["safetyStock"] == round(1.64 * (7.0 / math.sqrt(7)) * math.sqrt(14), 2)
    assert plan(metrics(curve="A"), "saudavel", supply(), policy)["serviceLevel"] == 0.99
    lot = plan(metrics(), "saudavel", supply(lot=10))
    assert lot["qty"] % 10 == 0 and lot["qty"] >= 86
    high_min = plan(metrics(min_qty=60), "saudavel", supply())
    assert high_min["reorderPoint"] == 60 and high_min["reorderFromOmieMin"] is True
    capped = plan(metrics(), "saudavel", supply(), {"maxCoverageDays": 25})
    assert capped["target"] == 50.0  # 25 dias × 2 un./dia, abaixo do alvo sem limite
    floor = plan(metrics(), "saudavel", supply(), {"maxCoverageDays": 15})
    assert floor["target"] == floor["reorderPoint"]  # 15 × 2 = 30 < ponto de reposição: fica no ponto


def test_service_level_follows_the_curve_with_biomie_defaults():
    expected = {"A": 0.95, "B": 0.90, "C": 0.85, "D": 0.80, None: 0.90}
    z = {0.95: 1.64, 0.90: 1.28, 0.85: 1.04, 0.80: 0.84}
    for curve, level in expected.items():
        r = plan(metrics(curve=curve), "saudavel", supply())
        assert r["serviceLevel"] == level and r["serviceLevelCurve"] == (curve or "U") and r["policySource"] == "padrao"
        assert r["safetyStock"] == round(z[level] * (7.0 / math.sqrt(7)) * math.sqrt(14), 2)
    r = plan(metrics(curve="C"), "risco_ruptura", supply())
    assert "nível de serviço 85%, curva C" in r["explanation"]
    assert any(e["key"] == "serviceLevel" and e["label"] == "Nível de serviço (curva C)" for e in r["evidence"])


def test_test_lead_time_is_labelled_as_simulation():
    r = plan(metrics(), "risco_ruptura", resolve_supply(IDX, "12"))
    assert r["status"] == "comprar" and r["leadTimeStatus"] == "teste"
    assert r["limitations"][0] == TEST_NOTE.format(days="30")
    assert "simulação" in r["explanation"] and r["evidence"][1]["label"].startswith("Prazo configurado na simulação")
    assert buy_recommendation(r)["action"].startswith("Simulação: comprar")


def test_do_not_buy_and_wait():
    assert plan(metrics(available=500), "possivel_excesso", supply())["status"] == "nao_comprar"
    assert plan(metrics(available=60, pending=0), "saudavel", supply())["status"] == "aguardar"


def test_cost_estimate_needs_reliable_cost():
    r = plan(metrics(known=False), "risco_ruptura", supply())
    assert r["status"] == "comprar" and r["costEstimate"] is None
    assert any("Custo estimado indisponível" in x for x in r["limitations"])
    assert plan(metrics(suspect=True), "risco_ruptura", supply())["costEstimate"] is None


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
    plans = [a for n, a in client.calls if n == "stock_intel_planning"]
    assert [a["p_company"] for a in plans] == ["c1", "c2"]  # uma entrada por empresa
    pub = [a for n, a in client.calls if n == "stock_intel_publish_opportunities"]
    assert len(pub) == 1 and pub[0]["p_chunk"] == 0 and pub[0]["p_rows"] == []  # lote 0 limpa a execução
    assert names.index("stock_intel_publish_opportunities") < names.index("stock_intel_finish")
    client = FakeClient()
    run(client, trigger="ops", company="mag-filial", log=lambda e: None)
    assert "stock_intel_publish_opportunities" not in [n for n, _ in client.calls]


def test_buy_suggestion_replaces_the_generic_replenishment_review():
    from datetime import date, timedelta

    from biomie_intel.engine import build_company_rows
    from test_metrics import base_product

    as_of = date(2026, 10, 23)
    sales = [["1", (as_of - timedelta(days=7 * w)).isoformat(), 20, 2000, 1] for w in range(40)]
    extract = {"companyId": "c1", "asOf": as_of.isoformat(), "salesFrom": "2026-01-01",
               "products": [base_product(qty=10, qtyPositive=10, curve="A")], "sales": sales, "returns": [],
               "curveHistory": []}
    planning = {"links": [["1", "9001"]], "suppliers": {"9001": "Alfa"},
                "leadTimes": [{"supplierId": "9001", "omie": "", "days": 20, "minLot": None, "status": "confirmado"}]}
    rows, stats = build_company_rows(extract, PARAMS, planning)
    recs = [r["type"] for r in rows[0]["metrics"]["recommendations"]]
    assert rows[0]["state"] == "risco_ruptura" and recs[0] == "comprar" and "avaliar_reposicao" not in recs
    assert stats["replenishment"] == {"comprar": 1}
