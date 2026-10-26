"""Diagnóstico, recomendações e alertas de cada produto (fase 3).

Tudo sai de regras verificáveis sobre os indicadores já calculados (metrics.py) e o estado (states.py).
Cada item diz a regra (código), a gravidade, os indicadores que o sustentam (evidências, com valor e
unidade) e o período. Regra sem dado não dispara: ausência de diagnóstico é melhor que diagnóstico
errado. Nenhum texto traz custo, capital, faturamento ou preço: esses valores só aparecem nas
evidências marcadas com "cost": true, e o item inteiro é marcado "requiresCost" quando depende deles;
o banco esconde os dois de quem não vê custo (stock.view_cost).

Diagnósticos (D) — o que está acontecendo:
  D01 sem saldo com venda nos últimos 90 dias          D08 produto novo
  D02 risco de ruptura (cobertura < limite)            D09 histórico insuficiente para concluir
  D03 demanda em queda (60 dias contra 60 anteriores)  D10 custo desconhecido / provisório / divergente
  D04 sem venda prolongada com estoque                 D11 saldo negativo
  D05 possível excesso (cobertura > limite)            D12 abaixo do mínimo do Omie
  D06 baixo giro                                       D13 devoluções
  D07 curva piorou                                     D14 estoque saudável
Recomendações (R) — o que avaliar (sempre consultivas, nunca executadas):
  R01 avaliar reposição      R03 recuperar capital         R05 conferir saldo no Omie
  R02 rever compras (queda)  R04 não comprar agora         R06 conferir custo no Omie
  R07 verificar o mínimo do Omie
Alertas (A) — situações incomuns, guardados entre execuções sem repetir o mesmo aviso:
  A01 queda abrupta de vendas           A06 custo acima do preço médio de venda
  A02 entrada recente acima da demanda  A07 parou de vender (vendia com frequência)
  A03 custo mudou desde a última análise A08 curva caiu dois níveis ou mais
  A04 custo muito diferente entre locais A09 faturamento da curva diferente das vendas
  A05 saldo negativo
"""

from __future__ import annotations

from datetime import date
from typing import Any

SEVERITIES = ("alta", "media", "baixa", "info")
CURVE_RANK = {"A": 1, "B": 2, "C": 3, "D": 4}

DEFAULTS = {"anomalyMinUnits": 5, "abruptDropPct": -50, "costChangePct": 30, "costDivergencePct": 20,
            "stoppedSellingMinInvoices": 3, "returnsAttentionPct": 10}


def param(params: dict[str, Any], key: str) -> float:
    value = params.get(key)
    return float(DEFAULTS[key] if value is None else value)


# --------------------------------------------------------------------------- formatação pt-BR

def num(value: float | None, digits: int = 1) -> str:
    """1234.5 -> '1.234,5'; inteiros sem casas decimais."""
    if value is None:
        return "—"
    v = float(value)
    if abs(v - round(v)) < 1e-9:
        digits = 0
    text = f"{v:,.{digits}f}"
    return text.replace(",", "§").replace(".", ",").replace("§", ".")


def day(value: Any) -> str:
    if value in (None, ""):
        return "—"
    d = value if isinstance(value, date) else date.fromisoformat(str(value)[:10])
    return d.strftime("%d/%m/%Y")


def ev(key: str, label: str, value: Any, unit: str | None = None, cost: bool = False) -> dict[str, Any]:
    item: dict[str, Any] = {"key": key, "label": label, "value": value}
    if unit:
        item["unit"] = unit
    if cost:
        item["cost"] = True
    return item


def _item(rule: str, code: str, severity: str, title: str, text: str, evidence: list[dict[str, Any]],
          period: str | None = None, requires_cost: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"rule": rule, "code": code, "severity": severity, "title": title, "text": text,
                           "evidence": [e for e in evidence if e["value"] is not None]}
    if period:
        out["period"] = period
    if requires_cost:
        out["requiresCost"] = True
    return out


def _top_curve(m: dict[str, Any]) -> bool:
    return m["curve"]["current"] in ("A", "B")


def _basis(m: dict[str, Any]) -> str:
    return {"90d": "últimos 90 dias", "365d": "dias observados dos últimos 12 meses"}.get(m.get("velocityBasis") or "",
                                                                                     "período observado")


# --------------------------------------------------------------------------- diagnósticos

def diagnose(m: dict[str, Any], state: str, flags: list[str], params: dict[str, Any]) -> list[dict[str, Any]]:
    stock, sales, cost = m["stock"], m["sales"], m["cost"]
    out: list[dict[str, Any]] = []
    units90 = sales["d90"]["units"]
    capital = ev("capital", "Capital imobilizado (a custo)", m["capital"], "R$", cost=True)

    if state == "sem_saldo" and (units90 or 0) > 0:
        out.append(_item("D01", "sem_saldo_com_demanda", "alta" if _top_curve(m) else "media",
                         "Sem saldo, com venda recente",
                         f"Sem saldo disponível e com {num(units90)} un. vendidas nos últimos 90 dias.",
                         [ev("stock.available", "Disponível", stock["available"], "un."),
                          ev("sales.d90.units", "Vendido em 90 dias", units90, "un."),
                          ev("curve.current", "Curva", m["curve"]["current"])], "últimos 90 dias"))

    if state == "risco_ruptura":
        limit = float(params["ruptureCoverageDays"])
        text = (f"Cobertura estimada de {num(m['coverageDays'])} dias, abaixo do limite de {num(limit)} dias, "
                f"com venda média de {num(m['velocityDaily'], 2)} un./dia ({_basis(m)}).")
        if (stock["pending"] or 0) > 0:
            text += f" Há {num(stock['pending'])} un. pendentes de recebimento."
        out.append(_item("D02", "risco_ruptura", "alta" if _top_curve(m) else "media", "Risco de ruptura", text,
                         [ev("coverageDays", "Cobertura estimada", m["coverageDays"], "dias"),
                          ev("velocityDaily", "Venda média", m["velocityDaily"], "un./dia"),
                          ev("stock.available", "Disponível", stock["available"], "un."),
                          ev("stock.pending", "Pendente de recebimento", stock["pending"] or None, "un."),
                          ev("params.ruptureCoverageDays", "Limite de ruptura", limit, "dias")], _basis(m)))

    if "demanda_em_queda" in flags and m["trend60Pct"] is not None:
        last60 = sales["d60"]["units"]
        prev60 = m.get("prev60Units")
        out.append(_item("D03", "demanda_em_queda", "alta" if _top_curve(m) else "media", "Demanda em queda",
                         f"Vendas dos últimos 60 dias {num(abs(m['trend60Pct']))}% abaixo das dos 60 dias anteriores "
                         f"({num(last60)} un. contra {num(prev60)} un.).",
                         [ev("trend60Pct", "Variação 60 dias", m["trend60Pct"], "%"),
                          ev("sales.d60.units", "Últimos 60 dias", last60, "un."),
                          ev("prev60Units", "60 dias anteriores", prev60, "un."),
                          ev("curve.current", "Curva", m["curve"]["current"])], "últimos 120 dias"))

    if state in ("possivel_obsolescencia", "sem_venda_janela"):
        idle = m.get("daysWithoutSale")
        text = f"Sem vendas há {num(idle)} dias observados, com {num(stock['qty'])} un. em estoque."
        if m.get("lastSale"):
            text += f" Última venda em {day(m['lastSale'])}."
        if m.get("elsewhereCompany"):
            text += f" A mesma SKU vendeu na {m['elsewhereCompany']}"
            text += f" (última venda em {day(m['elsewhereLastSale'])})." if m.get("elsewhereLastSale") else "."
        out.append(_item("D04", "sem_venda_prolongada", "alta" if state == "possivel_obsolescencia" else "media",
                         "Possível obsolescência" if state == "possivel_obsolescencia" else "Sem venda na janela",
                         text, [ev("daysWithoutSale", "Dias sem venda", idle, "dias"),
                                ev("stock.qty", "Saldo", stock["qty"], "un."),
                                ev("lastSale", "Última venda", m.get("lastSale")),
                                ev("elsewhereCompany", "Vendido no grupo", m.get("elsewhereCompany")), capital],
                         "últimos 12 meses"))

    if state == "possivel_excesso":
        limit = float(params["excessCoverageDays"])
        out.append(_item("D05", "possivel_excesso", "media", "Possível excesso",
                         f"Cobertura estimada de {num(m['coverageDays'])} dias, acima de {num(limit)} dias, "
                         f"com venda média de {num(m['velocityDaily'], 2)} un./dia ({_basis(m)}).",
                         [ev("coverageDays", "Cobertura estimada", m["coverageDays"], "dias"),
                          ev("velocityDaily", "Venda média", m["velocityDaily"], "un./dia"),
                          ev("stock.available", "Disponível", stock["available"], "un."),
                          ev("params.excessCoverageDays", "Limite de excesso", limit, "dias"), capital], _basis(m)))

    if state == "baixo_giro":
        limit = float(params["lowTurnoverAnnual"])
        out.append(_item("D06", "baixo_giro", "baixa", "Baixo giro",
                         f"Giro anual estimado de {num(m['turnoverAnnual'], 2)} vez(es), abaixo de {num(limit, 2)}.",
                         [ev("turnoverAnnual", "Giro anual estimado", m["turnoverAnnual"], "vezes/ano"),
                          ev("sales.d365.units", "Vendido nos dias observados", sales["d365"]["units"], "un."),
                          ev("stock.qty", "Saldo", stock["qty"], "un."), capital], "dias observados dos últimos 12 meses"))

    if "curva_piorou" in flags:
        curve = m["curve"]
        since = f" em {day(curve['changedOn'])}" if curve.get("changedOn") else ""
        out.append(_item("D07", "curva_piorou", "media", "Curva piorou",
                         f"A curva passou de {curve['previous']} para {curve['current']}{since}.",
                         [ev("curve.previous", "Curva anterior", curve["previous"]),
                          ev("curve.current", "Curva atual", curve["current"]),
                          ev("curve.changedOn", "Mudou em", curve.get("changedOn"))]))

    if state == "novo":
        out.append(_item("D08", "produto_novo", "info", "Produto novo",
                         f"Chegou em {day(m.get('arrivedOn'))}: ainda sem base para avaliar giro ou obsolescência."
                         if m.get("arrivedOn") else "Produto novo: ainda sem base para avaliar giro ou obsolescência.",
                         [ev("arrivedOn", "Chegada", m.get("arrivedOn"))]))

    if state == "historico_insuficiente":
        text = (f"Sem venda nos {num(m.get('daysWithoutSale'))} dias observados: pouco tempo para concluir que está parado."
                if m.get("daysWithoutSale") is not None else
                "Sem venda no período observado: pouco tempo para concluir que está parado.")
        if m.get("incompleteReason"):
            text += " O histórico de vendas ou de entradas é incompleto para este produto."
        out.append(_item("D09", "historico_insuficiente", "info", "Histórico insuficiente", text,
                         [ev("daysWithoutSale", "Dias observados sem venda", m.get("daysWithoutSale"), "dias"),
                          ev("historyCoveredDays", "Dias com vendas registradas", m.get("historyCoveredDays"), "dias")]))

    if "custo_desconhecido" in flags:
        out.append(_item("D10", "custo_desconhecido", "media", "Custo desconhecido",
                         "Sem custo no Omie: capital, margem e custo de reposição deste produto não são calculados.",
                         [ev("stock.qty", "Saldo", stock["qty"], "un.")], requires_cost=True))
    elif "custo_provisorio" in flags:
        out.append(_item("D10", "custo_provisorio", "media", "Custo provisório",
                         "Custo unitário muito baixo no Omie (provisório): o capital fica subestimado e a margem não é calculada.",
                         [ev("cost.unitCost", "Custo unitário", cost["unitCost"], "R$", cost=True),
                          ev("params.costSuspectMax", "Limite de custo provisório", float(params["costSuspectMax"]),
                             "R$", cost=True)], requires_cost=True))
    if "custo_divergente" in flags:
        out.append(_item("D10", "custo_divergente", "baixa", "Custo diferente entre locais",
                         "O custo unitário não é o mesmo em todos os locais do produto; o capital usa o custo de cada local.",
                         [ev("stock.locations", "Locais", stock["locations"])], requires_cost=True))

    if (stock["negativePositions"] or 0) > 0:
        out.append(_item("D11", "saldo_negativo", "alta", "Saldo negativo",
                         f"{num(stock['negativePositions'])} posição(ões) com saldo negativo: saída sem entrada "
                         "correspondente no Omie ou lançamento pendente.",
                         [ev("stock.negativePositions", "Posições negativas", stock["negativePositions"]),
                          ev("stock.negativeValue", "Valor negativo (a custo)", stock["negativeValue"], "R$", cost=True)]))

    if "abaixo_do_minimo" in flags:
        out.append(_item("D12", "abaixo_do_minimo", "media", "Abaixo do mínimo",
                         f"Saldo de {num(stock['qty'])} un. abaixo do mínimo cadastrado no Omie ({num(stock['minQty'])} un.).",
                         [ev("stock.qty", "Saldo", stock["qty"], "un."),
                          ev("stock.minQty", "Mínimo no Omie", stock["minQty"], "un.")]))

    returned = (m.get("returns365") or {}).get("units") or 0
    sold = sales["d365"]["units"] or 0
    if returned > 0:
        pct = returned / sold * 100 if sold > 0 else None
        attention = pct is not None and pct >= param(params, "returnsAttentionPct")
        text = f"Devoluções de {num(returned)} un. em {num(m['returns365']['events'])} evento(s) nos últimos 12 meses"
        text += f" ({num(pct)}% das unidades vendidas)." if pct is not None else "."
        out.append(_item("D13", "devolucoes", "media" if attention else "info", "Devoluções", text,
                         [ev("returns365.units", "Devolvido", returned, "un."),
                          ev("returns365.events", "Eventos", m["returns365"]["events"]),
                          ev("returnsPct", "Devolvido / vendido", None if pct is None else round(pct, 1), "%")],
                         "últimos 12 meses"))

    if state == "saudavel":
        out.append(_item("D14", "saudavel", "info", "Estoque saudável",
                         f"Cobertura estimada de {num(m['coverageDays'])} dias e giro anual de "
                         f"{num(m['turnoverAnnual'], 2)} vez(es).",
                         [ev("coverageDays", "Cobertura estimada", m["coverageDays"], "dias"),
                          ev("turnoverAnnual", "Giro anual estimado", m["turnoverAnnual"], "vezes/ano")]))

    out.sort(key=lambda d: SEVERITIES.index(d["severity"]))
    return out


# --------------------------------------------------------------------------- recomendações

def _rec(rule: str, kind: str, action: str, why: str, evidence: list[dict[str, Any]],
         limitations: list[str], requires_cost: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"rule": rule, "type": kind, "action": action, "why": why,
                           "evidence": [e for e in evidence if e["value"] is not None], "limitations": limitations}
    if requires_cost:
        out["requiresCost"] = True
    return out


def limitations_of(m: dict[str, Any], flags: list[str]) -> list[str]:
    out = []
    if "historico_incompleto" in flags:
        out.append("Histórico de vendas ou de entradas incompleto para este produto.")
    if (m.get("historyCoveredDays") or 0) < 365:
        out.append(f"Vendas registradas no BIOMIE só em {num(m.get('historyCoveredDays'))} dos últimos 365 dias.")
    return out


def recommend(m: dict[str, Any], state: str, flags: list[str], diagnoses: list[dict[str, Any]],
              params: dict[str, Any]) -> list[dict[str, Any]]:
    codes = {d["code"] for d in diagnoses}
    stock = m["stock"]
    base_limits = limitations_of(m, flags)
    out: list[dict[str, Any]] = []
    capital = ev("capital", "Capital imobilizado (a custo)", m["capital"], "R$", cost=True)

    if codes & {"sem_saldo_com_demanda", "risco_ruptura"}:
        out.append(_rec("R01", "avaliar_reposicao", "Avaliar reposição",
                        "A demanda recente consome o saldo disponível antes do limite de cobertura.",
                        [ev("coverageDays", "Cobertura estimada", m["coverageDays"], "dias"),
                         ev("velocityDaily", "Venda média", m["velocityDaily"], "un./dia"),
                         ev("stock.pending", "Pendente de recebimento", stock["pending"] or None, "un.")],
                        base_limits + ["Quantidade sugerida só com prazo de reposição informado (Reposição Inteligente)."]))
    if "demanda_em_queda" in codes and state not in ("sem_saldo",):
        out.append(_rec("R02", "rever_compras", "Rever compras planejadas e acompanhar a demanda",
                        "As vendas recentes caíram em relação ao período anterior; a causa não é conhecida pelo BIOMIE.",
                        [ev("trend60Pct", "Variação 60 dias", m["trend60Pct"], "%")], base_limits))
    if "sem_venda_prolongada" in codes or "baixo_giro" in codes:
        action = "Avaliar estratégia comercial de recuperação de capital (simulador de liquidação)"
        why = "Estoque parado ou de baixo giro."
        if m.get("elsewhereCompany"):
            action = f"Verificar demanda na {m['elsewhereCompany']} e avaliar estratégia comercial de recuperação"
            why += " A mesma SKU vendeu em outra empresa do grupo."
        out.append(_rec("R03", "recuperar_capital", action, why,
                        [ev("daysWithoutSale", "Dias sem venda", m.get("daysWithoutSale"), "dias"),
                         ev("turnoverAnnual", "Giro anual estimado", m["turnoverAnnual"], "vezes/ano"), capital],
                        base_limits + ["Receita de uma liquidação não é garantida."]))
    if codes & {"possivel_excesso", "sem_venda_prolongada"}:
        out.append(_rec("R04", "nao_comprar", "Não comprar agora",
                        "O saldo atual cobre a demanda observada por mais tempo que o limite de excesso, "
                        "ou não há venda que justifique nova compra.",
                        [ev("coverageDays", "Cobertura estimada", m["coverageDays"], "dias"),
                         ev("daysWithoutSale", "Dias sem venda", m.get("daysWithoutSale"), "dias")], base_limits))
    if "saldo_negativo" in codes:
        out.append(_rec("R05", "conferir_saldo", "Conferir os lançamentos do produto no Omie",
                        "Saldo negativo indica saída sem a entrada correspondente; a correção é feita no Omie.",
                        [ev("stock.negativePositions", "Posições negativas", stock["negativePositions"])], []))
    if codes & {"custo_desconhecido", "custo_provisorio"}:
        out.append(_rec("R06", "conferir_custo", "Conferir o custo do produto no Omie",
                        "Sem custo confiável, capital, margem e custo de reposição ficam suspensos.", [], [],
                        requires_cost=True))
    if "abaixo_do_minimo" in codes and not codes & {"sem_saldo_com_demanda", "risco_ruptura"}:
        out.append(_rec("R07", "verificar_minimo", "Verificar a necessidade de reposição",
                        "O saldo está abaixo do mínimo cadastrado no Omie.",
                        [ev("stock.qty", "Saldo", stock["qty"], "un."),
                         ev("stock.minQty", "Mínimo no Omie", stock["minQty"], "un.")], base_limits))
    return out


# --------------------------------------------------------------------------- alertas

def _alert(rule: str, kind: str, severity: str, reason: str, evidence: list[dict[str, Any]],
           requires_cost: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"rule": rule, "kind": kind, "severity": severity, "reason": reason,
                           "evidence": [e for e in evidence if e["value"] is not None]}
    if requires_cost:
        out["requiresCost"] = True
    return out


def detect_alerts(m: dict[str, Any], state: str, flags: list[str], params: dict[str, Any]) -> list[dict[str, Any]]:
    stock, sales, cost, curve = m["stock"], m["sales"], m["cost"], m["curve"]
    out: list[dict[str, Any]] = []
    min_units = param(params, "anomalyMinUnits")

    prev60 = m.get("prev60Units")
    if m["trend60Pct"] is not None and prev60 is not None and prev60 >= min_units \
            and m["trend60Pct"] <= param(params, "abruptDropPct"):
        out.append(_alert("A01", "queda_abrupta_vendas", "alta" if _top_curve(m) else "media",
                          f"Vendas caíram {num(abs(m['trend60Pct']))}% nos últimos 60 dias "
                          f"({num(sales['d60']['units'])} un. contra {num(prev60)} un.).",
                          [ev("trend60Pct", "Variação 60 dias", m["trend60Pct"], "%"),
                           ev("prev60Units", "60 dias anteriores", prev60, "un.")]))

    received30 = m.get("received30")
    units90 = sales["d90"]["units"]
    if received30 and received30 >= max(min_units, 2 * (units90 or 0)) and m["coverageDays"] is not None \
            and m["coverageDays"] > float(params["excessCoverageDays"]):
        out.append(_alert("A02", "entrada_acima_da_demanda", "media",
                          f"Entraram {num(received30)} un. nos últimos 30 dias, mais que o dobro do vendido em 90 dias "
                          f"({num(units90)} un.); cobertura estimada de {num(m['coverageDays'])} dias.",
                          [ev("received30", "Entradas em 30 dias", received30, "un."),
                           ev("sales.d90.units", "Vendido em 90 dias", units90, "un."),
                           ev("coverageDays", "Cobertura estimada", m["coverageDays"], "dias")]))

    prev_cost = cost.get("prevUnitCost")
    if cost["known"] and prev_cost and prev_cost > 0:
        change = (cost["unitCost"] - prev_cost) / prev_cost * 100
        if abs(change) >= param(params, "costChangePct"):
            out.append(_alert("A03", "custo_mudou", "media",
                              f"O custo unitário mudou {num(change)}% desde a análise anterior.",
                              [ev("cost.unitCost", "Custo atual", cost["unitCost"], "R$", cost=True),
                               ev("cost.prevUnitCost", "Custo anterior", prev_cost, "R$", cost=True),
                               ev("costChangePct", "Variação", round(change, 1), "%")], requires_cost=True))

    cost_min = cost.get("minUnitCost")
    if cost["known"] and cost_min and cost_min > 0:
        spread = (cost["unitCost"] - cost_min) / cost_min * 100
        if spread >= param(params, "costDivergencePct"):
            out.append(_alert("A04", "custo_divergente_locais", "baixa",
                              f"O maior custo entre os locais é {num(spread)}% acima do menor.",
                              [ev("cost.unitCost", "Maior custo", cost["unitCost"], "R$", cost=True),
                               ev("cost.minUnitCost", "Menor custo", cost_min, "R$", cost=True)], requires_cost=True))

    if (stock["negativePositions"] or 0) > 0:
        out.append(_alert("A05", "saldo_negativo", "alta",
                          f"{num(stock['negativePositions'])} posição(ões) com saldo negativo.",
                          [ev("stock.negativePositions", "Posições negativas", stock["negativePositions"]),
                           ev("stock.qty", "Saldo total", stock["qty"], "un.")]))

    if cost["known"] and not cost["suspect"] and m.get("avgPrice") and cost["unitCost"] > m["avgPrice"]:
        out.append(_alert("A06", "custo_acima_do_preco", "media",
                          "O custo unitário está acima do preço médio de venda dos últimos 12 meses.",
                          [ev("cost.unitCost", "Custo unitário", cost["unitCost"], "R$", cost=True),
                           ev("avgPrice", "Preço médio de venda", m["avgPrice"], "R$", cost=True)], requires_cost=True))

    invoices365 = sales["d365"]["invoices"] or 0
    covered = m.get("historyCoveredDays") or 0
    idle = m.get("daysWithoutSale")
    if invoices365 >= param(params, "stoppedSellingMinInvoices") and (sales["d60"]["units"] or 0) == 0 \
            and idle is not None and covered > 0:
        interval = covered / invoices365
        if idle >= max(60.0, 2 * interval):
            was_top = _top_curve(m) or curve.get("previous") in ("A", "B")
            out.append(_alert("A07", "parou_de_vender", "alta" if was_top else "media",
                              f"Vendia em média a cada {num(interval)} dias ({num(invoices365)} notas em 12 meses) "
                              f"e está há {num(idle)} dias sem venda.",
                              [ev("sales.d365.invoices", "Notas em 12 meses", invoices365),
                               ev("daysWithoutSale", "Dias sem venda", idle, "dias"),
                               ev("saleIntervalDays", "Intervalo médio entre vendas", round(interval, 1), "dias")]))

    previous, current = curve.get("previous"), curve.get("current")
    if previous in CURVE_RANK and current in CURVE_RANK and CURVE_RANK[current] - CURVE_RANK[previous] >= 2:
        out.append(_alert("A08", "curva_caiu_dois_niveis", "media",
                          f"A curva caiu de {previous} para {current}.",
                          [ev("curve.previous", "Curva anterior", previous), ev("curve.current", "Curva atual", current),
                           ev("curve.changedOn", "Mudou em", curve.get("changedOn"))]))

    revenue_curve, revenue_sales = curve.get("revenue12m"), sales["d365"]["revenue"]
    if revenue_curve is not None and revenue_sales is not None and curve.get("windowAligned"):
        diff = abs(revenue_curve - revenue_sales)
        if diff > max(100.0, 0.05 * max(revenue_curve, revenue_sales)):
            out.append(_alert("A09", "faturamento_divergente", "baixa",
                              "O faturamento de 12 meses usado na curva difere das vendas lidas nesta análise "
                              "(curva calculada antes das últimas notas?).",
                              [ev("curve.revenue12m", "Faturamento da curva", revenue_curve, "R$", cost=True),
                               ev("sales.d365.revenue", "Faturamento das vendas", revenue_sales, "R$", cost=True)],
                              requires_cost=True))
    out.sort(key=lambda a: SEVERITIES.index(a["severity"]))
    return out
