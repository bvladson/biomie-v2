import itertools
import json

from test_metrics import PARAMS, base_product, metrics_for

from biomie_intel.diagnosis import detect_alerts, diagnose, num, recommend
from biomie_intel.states import classify


def analyze(rows, history=None, **product):
    m = metrics_for(rows, base_product(**product), history=history)
    state, flags = classify(m, PARAMS)
    diagnoses = diagnose(m, state, flags, PARAMS)
    recs = recommend(m, state, flags, diagnoses, PARAMS)
    alerts = detect_alerts(m, state, flags, PARAMS)
    return state, flags, diagnoses, recs, alerts, m


def codes(items, key="code"):
    return [i[key] for i in items]


def find(items, value, key="code"):
    return next(i for i in items if i[key] == value)


def test_brazilian_number_format():
    assert num(1234.5) == "1.234,5" and num(10.0) == "10" and num(0.25, 2) == "0,25" and num(None) == "—"


def test_out_of_stock_with_recent_demand_recommends_replenishment_review():
    state, _f, d, r, _a, _m = analyze([["1", "2026-10-10", 4, 400, 2]], qty=0, qtyPositive=0, capital=None, curve="A")
    assert state == "sem_saldo"
    item = find(d, "sem_saldo_com_demanda")
    assert item["severity"] == "alta" and "4 un." in item["text"]
    assert "avaliar_reposicao" in codes(r, "type")
    assert any("prazo de reposição" in lim for lim in find(r, "avaliar_reposicao", "type")["limitations"])


def test_rupture_risk_uses_coverage_velocity_and_pending():
    state, _f, d, _r, _a, _m = analyze([["1", "2026-10-20", 900, 9000, 3]], pending=7, curve="C")
    assert state == "risco_ruptura"
    item = find(d, "risco_ruptura")
    assert item["severity"] == "media" and "7 un. pendentes" in item["text"]
    keys = {e["key"] for e in item["evidence"]}
    assert {"coverageDays", "velocityDaily", "params.ruptureCoverageDays", "stock.pending"} <= keys


def test_demand_drop_reports_both_periods_and_abrupt_alert():
    rows = [["1", "2026-07-01", 20, 2000, 4], ["1", "2026-10-10", 2, 200, 1]]  # 20 un. em 61–120 dias, 2 em 60
    _s, flags, d, r, a, m = analyze(rows, curve="B")
    assert "demanda_em_queda" in flags and m["prev60Units"] == 20
    item = find(d, "demanda_em_queda")
    assert item["severity"] == "alta" and "2 un. contra 20 un." in item["text"] and "90% abaixo" in item["text"]
    assert "rever_compras" in codes(r, "type")
    assert find(a, "queda_abrupta_vendas", "kind")["severity"] == "alta"


def test_small_volumes_do_not_raise_abrupt_drop_alert():
    rows = [["1", "2026-07-01", 3, 300, 1]]  # 3 un. antes, 0 depois: abaixo do volume mínimo (5)
    _s, flags, _d, _r, a, _m = analyze(rows)
    assert "demanda_em_queda" in flags and "queda_abrupta_vendas" not in codes(a, "kind")


def test_long_idle_with_group_sale_points_to_the_other_company():
    _s, _f, d, r, _a, _m = analyze([], daysWithoutSale=400, lastSale="2025-09-18", elsewhereCompany="Ergo Office",
                                   elsewhereLastSale="2026-10-01")
    item = find(d, "sem_venda_prolongada")
    assert item["severity"] == "alta" and item["title"] == "Possível obsolescência"
    assert "vendeu na Ergo Office (última venda em 01/10/2026)" in item["text"]
    assert any(e["key"] == "capital" and e.get("cost") for e in item["evidence"])
    rec = find(r, "recuperar_capital", "type")
    assert rec["action"].startswith("Verificar demanda na Ergo Office")
    assert "nao_comprar" in codes(r, "type")


def test_excess_low_turnover_and_healthy():
    state, _f, d, r, _a, _m = analyze([["1", "2026-03-01", 1, 100, 1]], qty=500, qtyPositive=500, capital=25000)
    assert state == "possivel_excesso" and "possivel_excesso" in codes(d) and "nao_comprar" in codes(r, "type")
    state, _f, d, _r, _a, _m = analyze([["1", "2026-10-10", 9, 900, 3]])
    assert state == "saudavel" and codes(d) == ["saudavel"]


def test_new_and_insufficient_history_are_information_not_problems():
    state, _f, d, r, _a, _m = analyze([], isNew=True, arrivedOn="2026-09-30", daysWithoutSale=23)
    assert state == "novo" and find(d, "produto_novo")["severity"] == "info" and "30/09/2026" in d[0]["text"]
    assert r == []
    state, _f, d, r, _a, _m = analyze([], daysWithoutSale=40, incompleteReason="sales")
    assert state == "historico_insuficiente" and "incompleto" in find(d, "historico_insuficiente")["text"]
    assert "recuperar_capital" not in codes(r, "type")


def test_cost_problems_are_cost_only_items():
    _s, _f, d, r, _a, _m = analyze([["1", "2026-10-10", 9, 900, 3]], costMax=None, costMin=None, capital=None)
    item = find(d, "custo_desconhecido")
    assert item.get("requiresCost") is True
    assert find(r, "conferir_custo", "type").get("requiresCost") is True
    _s, _f, d, _r, _a, _m = analyze([["1", "2026-10-10", 9, 900, 3]], costMax=0.5, costMin=0.5, capital=5)
    assert find(d, "custo_provisorio").get("requiresCost") is True


def test_negative_stock_minimum_and_returns():
    _s, _f, d, r, a, _m = analyze([["1", "2026-10-10", 9, 900, 3]], negativePositions=2, negativeValue=-300,
                                  minQty=20)
    assert find(d, "saldo_negativo")["severity"] == "alta" and "conferir_saldo" in codes(r, "type")
    assert "saldo_negativo" in codes(a, "kind")
    assert "abaixo do mínimo cadastrado no Omie (20 un.)" in find(d, "abaixo_do_minimo")["text"]


def test_curve_two_level_drop_alert():
    history = [("D", __import__("datetime").date(2026, 10, 20)), ("A", __import__("datetime").date(2026, 9, 1))]
    _s, flags, d, _r, a, _m = analyze([], history=history, curve="D", daysWithoutSale=120)
    assert "curva_piorou" in flags and "de A para D em 20/10/2026" in find(d, "curva_piorou")["text"]
    assert "curva_caiu_dois_niveis" in codes(a, "kind")


def test_cost_change_divergence_and_cost_above_price_alerts_need_cost():
    rows = [["1", "2026-10-10", 9, 900, 3]]  # preço médio 100
    _s, _f, _d, _r, a, _m = analyze(rows, costMax=130, costMin=90, capital=1300, prevUnitCost=80)
    kinds = codes(a, "kind")
    assert {"custo_mudou", "custo_divergente_locais", "custo_acima_do_preco"} <= set(kinds)
    assert all(find(a, k, "kind").get("requiresCost") for k in ("custo_mudou", "custo_divergente_locais",
                                                               "custo_acima_do_preco"))


def test_stopped_selling_and_receipt_above_demand():
    rows = [["1", f"2026-0{m}-1{m}", 2, 200, 1] for m in range(1, 8)]  # 7 notas até julho, nada depois
    _s, _f, _d, _r, a, m = analyze(rows, daysWithoutSale=100, curve="B")
    alert = find(a, "parou_de_vender", "kind")
    assert alert["severity"] == "alta" and "7 notas" in alert["reason"]
    rows = [["1", "2026-03-01", 1, 100, 1]]
    _s, _f, _d, _r, a, m = analyze(rows, qty=500, qtyPositive=500, capital=25000, received30=200)
    assert m["received30"] == 200 and "entrada_acima_da_demanda" in codes(a, "kind")


def test_revenue_divergence_only_when_the_curve_window_matches():
    rows = [["1", "2026-10-10", 9, 900, 3]]
    _s, _f, _d, _r, a, _m = analyze(rows, revenue12m=5000, curveWindowStart="2025-10-24")
    assert "faturamento_divergente" in codes(a, "kind")
    _s, _f, _d, _r, a, _m = analyze(rows, revenue12m=5000, curveWindowStart="2025-10-20")
    assert "faturamento_divergente" not in codes(a, "kind")


def test_texts_never_carry_money_and_cost_evidence_is_marked():
    variants = {
        "qty": [0, 10, 500], "costMax": [None, 0.5, 50, 130], "daysWithoutSale": [10, 120, 400],
        "negativePositions": [0, 1], "minQty": [0, 20], "elsewhereCompany": [None, "Ergo"],
    }
    keys = list(variants)
    sales = [[], [["1", "2026-10-10", 9, 900, 3]], [["1", "2026-07-01", 20, 2000, 4], ["1", "2026-10-10", 2, 200, 1]]]
    for values in itertools.product(*variants.values()):
        product = dict(zip(keys, values))
        product["qtyPositive"] = max(product["qty"], 0)
        product["costMin"] = product["costMax"]
        product["capital"] = None if product["costMax"] is None else product["qty"] * product["costMax"]
        for rows in sales:
            _s, _f, d, r, a, _m = analyze(rows, **product)
            for item in d + r + a:
                text = " ".join(str(item.get(k, "")) for k in ("title", "text", "action", "why", "reason"))
                assert "R$" not in text, item
                for e in item["evidence"]:
                    if e.get("unit") == "R$":
                        assert e.get("cost") is True, item
            json.dumps(d + r + a)  # tudo serializável
