from test_metrics import AS_OF, PARAMS, base_product, metrics_for

from biomie_intel.states import classify, priority


def state_of(rows, **product):
    m = metrics_for(rows, base_product(**product))
    return classify(m, PARAMS), m


def test_no_positive_stock_is_sem_saldo_with_recent_demand_flag():
    (state, flags), _ = state_of([["1", "2026-10-01", 3, 300, 1]], qty=0, qtyPositive=0, capital=None)
    assert state == "sem_saldo" and "demanda_recente" in flags


def test_new_product_is_never_obsolete():
    (state, _), m = state_of([], isNew=True, daysWithoutSale=400)
    assert state == "novo"
    score, parts = priority(m, state, 1.0, PARAMS)
    assert parts["idle"] == 0 and parts["coverage"] == 0 and score == 40.0  # só o peso do capital


def test_no_sales_states_depend_on_observed_days():
    assert state_of([], daysWithoutSale=400)[0][0] == "possivel_obsolescencia"
    assert state_of([], daysWithoutSale=120)[0][0] == "sem_venda_janela"
    assert state_of([], daysWithoutSale=40)[0][0] == "historico_insuficiente"


def test_selling_products_by_coverage_and_turnover():
    # 9 em 90 dias = 0,1/dia; 10 em estoque = 100 dias de cobertura: saudável
    assert state_of([["1", "2026-10-10", 9, 900, 3]])[0][0] == "saudavel"
    # 30 por dia: cobertura < 15 dias
    assert state_of([["1", "2026-10-20", 900, 9000, 3]])[0][0] == "risco_ruptura"
    # 1 venda no ano com 500 em estoque: cobertura enorme
    assert state_of([["1", "2026-03-01", 1, 100, 1]], qty=500, qtyPositive=500, capital=25000)[0][0] == "possivel_excesso"


def test_flags_are_evidence_not_states():
    (state, flags), _ = state_of([["1", "2026-10-10", 9, 900, 3]], costMax=None, costMin=None, capital=None,
                                 negativePositions=1, elsewhereCompany="Ergo", incompleteReason="sales")
    assert state == "saudavel"
    assert {"custo_desconhecido", "saldo_negativo", "vendido_no_grupo", "historico_incompleto"} <= set(flags)


def test_priority_formula_and_no_priority_without_stock():
    (state, _), m = state_of([], daysWithoutSale=183)
    score, parts = priority(m, state, 0.5, PARAMS)
    # 100 × (0,4·0,5 + 0,3·(183/365) + 0,15·1 [sem consumo] + 0,15·0)
    assert score == round(100 * (0.4 * 0.5 + 0.3 * (183 / 365) + 0.15 * 1.0), 2)
    assert parts["coverage"] == 1.0
    (state0, _), m0 = state_of([], qty=0, qtyPositive=0, capital=None)
    assert priority(m0, state0, None, PARAMS) == (None, None)


def test_reference_date_is_fixed():
    assert AS_OF.isoformat() == "2026-10-23"
