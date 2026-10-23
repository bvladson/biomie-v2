"""Estado analítico, sinais e índice de prioridade de cada produto.

Complementam a Curva ABCD oficial, nunca a substituem: a curva continua a do banco.

Estados (um por produto, avaliados nesta ordem):
1. sem_saldo: sem saldo positivo (pode ter demanda recente: sinal "demanda_recente");
2. novo: chegou há menos de newProductDays dias, nunca tratado como encalhe;
3. sem venda nos dias cobertos dos últimos 12 meses:
   - possivel_obsolescencia: pelo menos obsolescenceDays sem venda observados;
   - sem_venda_janela: pelo menos 90 dias sem venda observados;
   - historico_insuficiente: observado há menos tempo que isso;
4. com venda:
   - risco_ruptura: cobertura < ruptureCoverageDays;
   - possivel_excesso: cobertura > excessCoverageDays;
   - baixo_giro: giro anual estimado < lowTurnoverAnnual;
   - saudavel: nenhum dos anteriores.

Índice de prioridade, de 0 a 100: ordena o que olhar primeiro; não é probabilidade.
    100 × (wCapital·C + wIdle·I + wCoverage·V + wTrend·T)
  C = posição do capital do produto entre os produtos com saldo da empresa (percentil de 0 a 1;
      custo desconhecido = 0, com o sinal "custo_desconhecido");
  I = dias sem venda ÷ 365, limitado a 1 (produto novo = 0);
  V = cobertura ÷ 365, limitada a 1; sem consumo observado = 1 (produto novo = 0);
  T = queda das vendas dos últimos 60 dias contra os 60 anteriores ÷ 100, entre 0 e 1 (desconhecida = 0).
Só produtos com saldo positivo recebem índice.
"""

from __future__ import annotations

from typing import Any

STATES = ("novo", "historico_insuficiente", "sem_venda_janela", "baixo_giro", "possivel_excesso",
          "possivel_obsolescencia", "saudavel", "risco_ruptura", "sem_saldo")


def classify(m: dict[str, Any], params: dict[str, Any]) -> tuple[str, list[str]]:
    stock, sales = m["stock"], m["sales"]
    qty = stock["qty"] or 0.0
    units365 = sales["d365"]["units"] or 0.0
    units90 = sales["d90"]["units"] or 0.0
    flags: list[str] = []
    if m.get("incompleteReason"):
        flags.append("historico_incompleto")
    if qty > 0 and not m["cost"]["known"]:
        flags.append("custo_desconhecido")
    if m["cost"]["suspect"]:
        flags.append("custo_provisorio")
    if m["cost"]["divergentLocations"]:
        flags.append("custo_divergente")
    if (stock["negativePositions"] or 0) > 0:
        flags.append("saldo_negativo")
    if m["trend60Pct"] is not None and m["trend60Pct"] <= float(params["trendDeclinePct"]):
        flags.append("demanda_em_queda")
    if m["curve"]["worsened"]:
        flags.append("curva_piorou")
    if m.get("elsewhereCompany"):
        flags.append("vendido_no_grupo")
    if m.get("recentExit"):
        flags.append("saida_recente")
    if m.get("lastExitGroup"):
        flags.append("venda_para_grupo")
    if (m["returns365"]["units"] or 0) > 0:
        flags.append("devolucoes")
    if (stock["minQty"] or 0) > 0 and qty < stock["minQty"]:
        flags.append("abaixo_do_minimo")
    if (stock["pending"] or 0) > 0:
        flags.append("pendente_recebimento")
    if qty > 0 and m["velocityDaily"] == 0:
        flags.append("sem_consumo")

    if qty <= 0:
        if units90 > 0:
            flags.append("demanda_recente")
        return "sem_saldo", flags
    if m.get("isNew"):
        return "novo", flags
    if units365 <= 0:
        idle = m.get("daysWithoutSale")
        if idle is not None and idle >= int(params["obsolescenceDays"]):
            return "possivel_obsolescencia", flags
        if idle is not None and idle >= 90:
            return "sem_venda_janela", flags
        return "historico_insuficiente", flags
    coverage = m["coverageDays"]
    if coverage is not None and coverage < float(params["ruptureCoverageDays"]):
        return "risco_ruptura", flags
    if coverage is not None and coverage > float(params["excessCoverageDays"]):
        return "possivel_excesso", flags
    if m["turnoverAnnual"] is not None and m["turnoverAnnual"] < float(params["lowTurnoverAnnual"]):
        return "baixo_giro", flags
    return "saudavel", flags


def priority(m: dict[str, Any], state: str, capital_pct: float | None,
             params: dict[str, Any]) -> tuple[float | None, dict[str, Any] | None]:
    if (m["stock"]["qty"] or 0) <= 0:
        return None, None
    weights = params["priorityWeights"]
    is_new = state == "novo"
    c = capital_pct if capital_pct is not None else 0.0
    idle = m.get("daysWithoutSale")
    i = 0.0 if is_new or idle is None else min(float(idle) / 365.0, 1.0)
    if is_new:
        v = 0.0
    elif m["coverageDays"] is None:
        v = 1.0
    else:
        v = min(float(m["coverageDays"]) / 365.0, 1.0)
    trend = m["trend60Pct"]
    t = 0.0 if trend is None else min(max(-float(trend) / 100.0, 0.0), 1.0)
    parts = {"capital": round(c, 4), "idle": round(i, 4), "coverage": round(v, 4), "trend": round(t, 4),
             "weights": weights}
    score = 100.0 * (float(weights["capital"]) * c + float(weights["idle"]) * i
                     + float(weights["coverage"]) * v + float(weights["trend"]) * t)
    return round(score, 2), parts
