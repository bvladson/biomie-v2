"""Reposição Inteligente e oportunidades entre empresas (fase 5). Tudo consultivo: o BIOMIE não cria
pedido de compra, não transfere estoque e não altera nada no Omie.

Reposição (por produto e empresa), só quando há prazo de reposição informado por um usuário autorizado
(produto > família > empresa) e previsão de demanda aprovada no teste histórico (fase 4):
  d   = demanda diária prevista (modelo escolhido no teste)
  σd  = desvio semanal da demanda ÷ √7
  L   = prazo de reposição (dias); R = ciclo de revisão (dias); z = nível de serviço (0,80 → 0,84 …
        0,90 → 1,28 … 0,99 → 2,33)
  estoque de segurança  ES  = z × σd × √L
  ponto de reposição    PR  = d × L + ES (no mínimo o estoque mínimo do Omie, quando houver)
  posição               P   = disponível + pendente de recebimento
  alvo                  A   = PR + d × R (limitado a d × cobertura máxima, quando informada, sem ficar
                              abaixo de PR)
  P ≤ PR → comprar A − P, arredondado para cima ao lote mínimo (quando informado);
  P > A  → não comprar agora; entre PR e A → sem compra neste ciclo.
Sem prazo, sem previsão confiável ou sem demanda: nenhuma quantidade (e a tela diz por quê).

Oportunidades entre empresas: mesma SKU (o critério do "vendido no grupo" da curva) com sobra numa
empresa (excesso, possível obsolescência, sem venda na janela ou baixo giro; sobra = disponível −
demanda prevista dela em 90 dias) e falta em outra (demanda prevista e cobertura abaixo do limite de
ruptura ou sem saldo; necessidade = demanda de 90 dias − posição). Quantidade = menor das duas.
Transferência entre CNPJs pode exigir nota fiscal e processos próprios: o BIOMIE só aponta.
"""

from __future__ import annotations

import math
from typing import Any

from .diagnosis import ev, num

Z_SCORES = {0.80: 0.84, 0.85: 1.04, 0.90: 1.28, 0.95: 1.64, 0.97: 1.88, 0.98: 2.05, 0.99: 2.33}
DONOR_STATES = ("possivel_excesso", "possivel_obsolescencia", "sem_venda_janela", "baixo_giro")
OPPORTUNITY_DAYS = 90
TRANSFER_NOTE = ("Movimentação entre CNPJs pode exigir nota fiscal e processos fiscais e operacionais "
                 "específicos. O BIOMIE não executa transferências.")


def resolve_params(rows: list[dict[str, Any]], company_id: str, omie: str, family: str | None) -> dict[str, Any] | None:
    """Parâmetro mais específico: produto > família > empresa."""
    mine = [r for r in rows if r.get("companyId") == company_id]
    for scope, key in (("produto", omie), ("familia", family or None), ("empresa", "")):
        if key is None:
            continue
        for r in mine:
            if r.get("scope") == scope and (r.get("key") or "") == key:
                return r
    return None


def plan(m: dict[str, Any], state: str, params_row: dict[str, Any] | None) -> dict[str, Any]:
    f = m.get("forecast") or {}
    stock, cost = m["stock"], m["cost"]
    available = float(stock["available"] or 0)
    pending = float(stock["pending"] or 0)
    if params_row is None or not params_row.get("leadTimeDays"):
        return {"status": "sem_prazo",
                "message": "Prazo de reposição não informado: defina-o para calcular a sugestão de compra."}
    lead = int(params_row["leadTimeDays"])
    review = int(params_row.get("reviewDays") or 30)
    level = float(params_row.get("serviceLevel") or 0.90)
    z = Z_SCORES.get(round(level, 2), 1.28)
    common: dict[str, Any] = {"leadTimeDays": lead, "reviewDays": review, "serviceLevel": level,
                              "paramsSource": params_row.get("scope"), "minLot": params_row.get("minLot"),
                              "maxCoverageDays": params_row.get("maxCoverageDays")}
    if f.get("status") != "ok":
        return {**common, "status": "sem_previsao",
                "message": "Sem previsão de demanda confiável: sugestão de compra suspensa."}
    daily = float(f["dailyRate"])
    if daily <= 0:
        return {**common, "status": "sem_demanda", "message": "Demanda prevista zero: nenhuma compra sugerida."}
    sigma_daily = float(f.get("weeklyStd") or 0) / math.sqrt(7)
    safety = z * sigma_daily * math.sqrt(lead)
    reorder = daily * lead + safety
    min_qty = float(stock["minQty"] or 0)
    reorder_from_min = min_qty > reorder
    reorder = max(reorder, min_qty)
    position = available + pending
    target = reorder + daily * review
    max_cov = params_row.get("maxCoverageDays")
    if max_cov:
        target = max(reorder, min(target, daily * float(max_cov)))
    coverage = position / daily if position > 0 else 0.0
    limitations = []
    quality = (f.get("backtest") or {}).get("quality")
    if quality == "fraca":
        wape = (f.get("backtest") or {}).get("wape")
        limitations.append(f"Previsão de qualidade fraca no teste histórico (erro de {num((wape or 0) * 100)}% do vendido).")
    if not params_row.get("minLot"):
        limitations.append("Lote mínimo de compra não informado.")
    limitations.append("Restrições de fornecimento e preço de compra não estão no BIOMIE.")
    evidence = [ev("forecast.dailyRate", "Demanda prevista", round(daily, 3), "un./dia"),
                ev("leadTimeDays", "Prazo de reposição", lead, "dias"),
                ev("safetyStock", "Estoque de segurança", round(safety, 1), "un."),
                ev("reorderPoint", "Ponto de reposição", round(reorder, 1), "un."),
                ev("position", "Disponível + pendente", round(position, 3), "un."),
                ev("target", "Estoque alvo", round(target, 1), "un.")]
    base = {**common, "dailyDemand": round(daily, 4), "safetyStock": round(safety, 2), "reorderPoint": round(reorder, 2),
            "reorderFromOmieMin": reorder_from_min, "position": round(position, 3), "target": round(target, 2),
            "coverageDays": round(coverage, 1), "model": f.get("model"), "forecastQuality": quality,
            "evidence": evidence, "limitations": limitations}
    explanation = (f"Demanda prevista de {num(daily, 2)} un./dia; prazo de reposição de {num(lead)} dias; estoque de "
                   f"segurança de {num(safety)} un. (nível de serviço {num(level * 100)}%); ponto de reposição de "
                   f"{num(reorder)} un.; disponível + pendente = {num(position)} un.")
    if position <= reorder:
        need = max(target - position, 0.0)
        lot = float(params_row.get("minLot") or 0)
        qty = math.ceil(need / lot) * lot if lot > 0 else math.ceil(need)
        if coverage < lead:
            shortage = daily * (lead - coverage)
            risk = (f"Sem comprar agora, o saldo cobre cerca de {num(coverage)} dias, menos que o prazo de reposição "
                    f"de {num(lead)} dias: falta estimada de {num(shortage)} un. até a próxima entrega.")
        else:
            risk = (f"O saldo cobre cerca de {num(coverage)} dias e já está no ponto de reposição: "
                    "comprando depois, a entrega pode chegar com o estoque de segurança consumido.")
        cost_estimate = round(qty * cost["unitCost"], 2) if cost["known"] and not cost["suspect"] else None
        if cost_estimate is None:
            limitations.append("Custo estimado indisponível: custo do produto desconhecido ou provisório.")
        return {**base, "status": "comprar", "qty": qty, "costEstimate": cost_estimate, "risk": risk,
                "explanation": explanation}
    if position > target:
        return {**base, "status": "nao_comprar", "qty": 0,
                "explanation": explanation + f"; acima do alvo de {num(target)} un.: não comprar agora."}
    return {**base, "status": "aguardar", "qty": 0,
            "explanation": explanation + "; acima do ponto de reposição: sem compra neste ciclo."}


def buy_recommendation(r: dict[str, Any]) -> dict[str, Any] | None:
    if r.get("status") != "comprar":
        return None
    return {"rule": "R08", "type": "comprar", "action": f"Comprar {num(r['qty'])} un. (sugestão para revisão)",
            "why": r["risk"], "evidence": r["evidence"], "limitations": r["limitations"]}


# --------------------------------------------------------------------------- entre empresas

def sku_key(sku: Any, omie: str) -> str | None:
    text = str(sku or "").strip()
    return text if text and text != omie else None


def index_entry(company: dict[str, Any], row: dict[str, Any]) -> dict[str, Any] | None:
    m = row["metrics"]
    key = sku_key(row.get("sku"), row["omieProductId"])
    if key is None:
        return None
    f = m.get("forecast") or {}
    daily = float(f["dailyRate"]) if f.get("status") == "ok" else None
    cost = m["cost"]
    return {"sku": key, "companyId": company["id"], "companyName": company.get("name"), "omie": row["omieProductId"],
            "name": row.get("name"), "state": row["state"], "available": float(m["stock"]["available"] or 0),
            "pending": float(m["stock"]["pending"] or 0), "daily": daily, "idle": m.get("daysWithoutSale"),
            "unitCost": cost["unitCost"] if cost["known"] and not cost["suspect"] else None}


def opportunities(entries: list[dict[str, Any]], rupture_days: float) -> list[dict[str, Any]]:
    by_sku: dict[str, list[dict[str, Any]]] = {}
    for e in entries:
        by_sku.setdefault(e["sku"], []).append(e)
    out: list[dict[str, Any]] = []
    for sku, group in sorted(by_sku.items()):
        if len({e["companyId"] for e in group}) < 2:
            continue
        donors, receivers = [], []
        for e in group:
            own_need = (e["daily"] or 0.0) * OPPORTUNITY_DAYS
            excess = math.floor(e["available"] - own_need)
            if e["state"] in DONOR_STATES and e["available"] >= 1 and excess >= 1:
                donors.append([e, excess])
            if e["daily"] and e["daily"] > 0:
                position = e["available"] + e["pending"]
                coverage = position / e["daily"] if position > 0 else 0.0
                need = math.ceil(e["daily"] * OPPORTUNITY_DAYS - position)
                if (coverage < rupture_days or e["available"] <= 0) and need >= 1:
                    receivers.append([e, need, coverage])
        donors.sort(key=lambda d: (-d[1], d[0]["companyId"]))
        receivers.sort(key=lambda r: (-r[1], r[0]["companyId"]))
        for receiver in receivers:
            for donor in donors:
                if donor[0]["companyId"] == receiver[0]["companyId"] or donor[1] < 1 or receiver[1] < 1:
                    continue
                qty = min(donor[1], receiver[1])
                d, r = donor[0], receiver[0]
                out.append({
                    "rule": "O01", "sku": sku, "name": r["name"] or d["name"], "qty": qty,
                    "fromCompanyId": d["companyId"], "fromOmie": d["omie"], "toCompanyId": r["companyId"], "toOmie": r["omie"],
                    "from": {"companyName": d["companyName"], "available": d["available"], "state": d["state"],
                             "idleDays": d["idle"], "dailyDemand": d["daily"]},
                    "to": {"companyName": r["companyName"], "available": r["available"], "pending": r["pending"],
                           "dailyDemand": r["daily"], "coverageDays": round(receiver[2], 1)},
                    "valueAtCost": round(qty * d["unitCost"], 2) if d["unitCost"] is not None else None,
                    "reason": (f"{d['companyName']} tem sobra de {num(donor[1])} un. ({d['state'].replace('_', ' ')}) e "
                               f"{r['companyName']} precisa de cerca de {num(receiver[1])} un. para {OPPORTUNITY_DAYS} dias "
                               f"(demanda prevista de {num(r['daily'], 2)} un./dia, cobertura de {num(receiver[2])} dias)."),
                    "note": TRANSFER_NOTE, "horizonDays": OPPORTUNITY_DAYS,
                })
                donor[1] -= qty
                receiver[1] -= qty
    return out
