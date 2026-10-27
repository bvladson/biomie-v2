"""Reposição Inteligente e oportunidades entre empresas (fase 5). Tudo consultivo: o BIOMIE não cria
pedido de compra, não transfere estoque e não altera nada no Omie.

Fornecedor e prazo (migração 0048): cada produto tem os fornecedores vinculados no Omie (Produto x
Fornecedor) ou por Compras, e cada fornecedor um prazo de entrega em dias corridos, do produto ou o padrão
dele na empresa (o do produto prevalece). O fornecedor da reposição é o principal (definido por Compras);
senão o único vinculado; senão o único com prazo. Vários com prazo e nenhum principal = "fornecedor a
definir". Sem fornecedor, sem prazo confiável ou com fornecedor a definir: nenhuma quantidade (a tela diz
por quê). Prazo de teste só existe na homologação e sai rotulado como simulação.

Reposição (por produto e empresa), com o prazo do fornecedor escolhido e a previsão de demanda aprovada no
teste histórico (fase 4):
  d   = demanda diária prevista (modelo escolhido no teste)
  σd  = desvio semanal da demanda ÷ √7
  L   = prazo de entrega (dias corridos); R = ciclo de revisão (dias); z = nível de serviço (0,80 → 0,84 …
        0,90 → 1,28 … 0,99 → 2,33); R, z e a cobertura máxima vêm da política de reposição da empresa
        (Compras) ou dos padrões do BIOMIE (30 dias, 90%, sem cobertura máxima), sempre identificados
  estoque de segurança  ES  = z × σd × √L
  ponto de reposição    PR  = d × L + ES (no mínimo o estoque mínimo do Omie, quando houver)
  posição               P   = disponível + pendente de recebimento
  alvo                  A   = PR + d × R (limitado a d × cobertura máxima, quando informada, sem ficar
                              abaixo de PR)
  P ≤ PR → comprar A − P, arredondado para cima ao lote mínimo do fornecedor (quando informado);
  P > A  → não comprar agora; entre PR e A → sem compra neste ciclo.

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


DEFAULT_POLICY = {"reviewDays": 30, "serviceLevel": 0.90, "maxCoverageDays": None}
TEST_NOTE = ("Prazo configurado na simulação: {days} dias. O prazo deve ser confirmado por Compras antes de "
             "servir de base a recomendações reais.")
MAX_ALTERNATIVES = 10


def index_planning(planning: dict[str, Any] | None) -> dict[str, Any]:
    """Entrada de uma empresa (stock_intel_planning) em mapas por produto e fornecedor."""
    p = planning or {}
    links: dict[str, list[str]] = {}
    for omie, supplier in p.get("links") or []:
        links.setdefault(str(omie), []).append(str(supplier))
    lead = {(str(t["supplierId"]), str(t.get("omie") or "")): t for t in p.get("leadTimes") or []}
    return {"links": links, "lead": lead,
            "preferred": {str(k): str(v) for k, v in (p.get("preferred") or {}).items()},
            "names": {str(k): v for k, v in (p.get("suppliers") or {}).items()},
            "policy": p.get("policy") or None}


def supplier_option(idx: dict[str, Any], supplier: str, omie: str) -> dict[str, Any]:
    own = idx["lead"].get((supplier, omie))
    row = own or idx["lead"].get((supplier, ""))
    return {"id": supplier, "name": idx["names"].get(supplier) or f"Fornecedor {supplier}",
            "leadTimeDays": int(row["days"]) if row else None,
            "leadTimeSource": ("produto" if own else "fornecedor") if row else None,
            "leadTimeStatus": row.get("status") if row else None,
            "minLot": float(row["minLot"]) if row and row.get("minLot") is not None else None}


def resolve_supply(idx: dict[str, Any], omie: str) -> dict[str, Any]:
    """Fornecedor da reposição: principal > único vinculado > único com prazo; senão diz o que falta."""
    linked = sorted(set(idx["links"].get(omie, [])))
    if not linked:
        return {"status": "sem_fornecedor", "suppliers": [], "notes": []}
    options = sorted((supplier_option(idx, s, omie) for s in linked),
                     key=lambda o: (o["leadTimeDays"] is None, o["name"], o["id"]))
    alternatives = options[:MAX_ALTERNATIVES]
    notes: list[str] = []
    preferred = idx["preferred"].get(omie)
    chosen, choice = None, None
    if preferred in linked:
        chosen, choice = next(o for o in options if o["id"] == preferred), "principal"
    else:
        if preferred:
            notes.append("O fornecedor principal definido por Compras não está mais vinculado ao produto.")
        with_lead = [o for o in options if o["leadTimeDays"]]
        if len(options) == 1:
            chosen, choice = options[0], "unico"
        elif len(with_lead) == 1:
            chosen, choice = with_lead[0], "unico_com_prazo"
        elif with_lead:
            return {"status": "fornecedor_indefinido", "suppliers": alternatives, "notes": notes}
        else:
            return {"status": "sem_prazo", "suppliers": alternatives, "notes": notes}
    supplier = {**chosen, "choice": choice}
    if not chosen["leadTimeDays"]:
        return {"status": "sem_prazo", "supplier": supplier, "suppliers": alternatives, "notes": notes}
    return {"status": "ok", "supplier": supplier, "suppliers": alternatives, "notes": notes}


def plan(m: dict[str, Any], state: str, supply: dict[str, Any] | None,
         policy: dict[str, Any] | None = None) -> dict[str, Any]:
    f = m.get("forecast") or {}
    stock, cost = m["stock"], m["cost"]
    available = float(stock["available"] or 0)
    pending = float(stock["pending"] or 0)
    supply = supply or {"status": "sem_fornecedor", "suppliers": [], "notes": []}
    pol = {**DEFAULT_POLICY, **{k: v for k, v in (policy or {}).items() if v is not None}}
    review = int(pol["reviewDays"])
    level = float(pol["serviceLevel"])
    max_cov = pol.get("maxCoverageDays")
    info: dict[str, Any] = {"suppliers": supply.get("suppliers") or [], "reviewDays": review, "serviceLevel": level,
                            "maxCoverageDays": max_cov, "policySource": "compras" if policy else "padrao"}
    if supply.get("notes"):
        info["notes"] = supply["notes"]
    if supply["status"] == "sem_fornecedor":
        return {**info, "status": "sem_fornecedor",
                "message": ("Nenhum fornecedor vinculado a este produto (no Omie ou pelo BIOMIE): a quantidade de "
                            "reposição está indisponível.")}
    if supply["status"] == "fornecedor_indefinido":
        listed = "; ".join(f"{o['name']}: {num(o['leadTimeDays'])} dias" for o in info["suppliers"] if o["leadTimeDays"])
        return {**info, "status": "fornecedor_indefinido",
                "message": (f"Mais de um fornecedor com prazo informado ({listed}): Compras precisa indicar o "
                            "fornecedor principal. Até lá, a quantidade de reposição está indisponível.")}
    if supply["status"] == "sem_prazo":
        chosen = supply.get("supplier")
        who = f" do fornecedor {chosen['name']}" if chosen else " dos fornecedores vinculados"
        out = {**info, "status": "sem_prazo",
               "message": (f"Sem prazo de entrega confiável{who}: a quantidade de reposição está indisponível. "
                           "Compras informa o prazo em Estoque › Fornecedores e prazos.")}
        if chosen:
            out["supplier"] = chosen
        return out
    s = supply["supplier"]
    lead = int(s["leadTimeDays"])
    lot = s.get("minLot")
    test = s.get("leadTimeStatus") == "teste"
    z = Z_SCORES.get(round(level, 2), 1.28)
    common: dict[str, Any] = {**info, "supplier": s, "leadTimeDays": lead, "leadTimeSource": s.get("leadTimeSource"),
                              "leadTimeStatus": s.get("leadTimeStatus"), "minLot": lot}
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
    if max_cov:
        target = max(reorder, min(target, daily * float(max_cov)))
    coverage = position / daily if position > 0 else 0.0
    limitations = []
    if test:
        limitations.append(TEST_NOTE.format(days=num(lead)))
    limitations.extend(supply.get("notes") or [])
    quality = (f.get("backtest") or {}).get("quality")
    if quality == "fraca":
        wape = (f.get("backtest") or {}).get("wape")
        limitations.append(f"Previsão de qualidade fraca no teste histórico (erro de {num((wape or 0) * 100)}% do vendido).")
    if not lot:
        limitations.append("Lote mínimo de compra do fornecedor não informado.")
    if not policy:
        limitations.append("Ciclo de revisão e nível de serviço padrão do BIOMIE (30 dias, 90%): Compras pode "
                           "ajustar a política de reposição da empresa.")
    limitations.append("Preço de compra e restrições do fornecedor não estão no BIOMIE.")
    lead_label = "Prazo configurado na simulação" if test else "Prazo de entrega"
    origin = "do produto" if s.get("leadTimeSource") == "produto" else "padrão do fornecedor"
    evidence = [ev("forecast.dailyRate", "Demanda prevista", round(daily, 3), "un./dia"),
                ev("leadTimeDays", f"{lead_label} ({s['name']}, {origin})", lead, "dias corridos"),
                ev("safetyStock", "Estoque de segurança", round(safety, 1), "un."),
                ev("reorderPoint", "Ponto de reposição", round(reorder, 1), "un."),
                ev("position", "Disponível + pendente", round(position, 3), "un."),
                ev("target", "Estoque alvo", round(target, 1), "un.")]
    base = {**common, "dailyDemand": round(daily, 4), "safetyStock": round(safety, 2), "reorderPoint": round(reorder, 2),
            "reorderFromOmieMin": reorder_from_min, "position": round(position, 3), "target": round(target, 2),
            "coverageDays": round(coverage, 1), "model": f.get("model"), "forecastQuality": quality,
            "evidence": evidence, "limitations": limitations}
    lead_text = (f"prazo configurado na simulação de {num(lead)} dias" if test
                 else f"prazo de entrega de {num(lead)} dias corridos")
    explanation = (f"Demanda prevista de {num(daily, 2)} un./dia; {lead_text} ({s['name']}); estoque de "
                   f"segurança de {num(safety)} un. (nível de serviço {num(level * 100)}%); ponto de reposição de "
                   f"{num(reorder)} un.; disponível + pendente = {num(position)} un.")
    if position <= reorder:
        need = max(target - position, 0.0)
        step = float(lot or 0)
        qty = math.ceil(need / step) * step if step > 0 else math.ceil(need)
        if coverage < lead:
            shortage = daily * (lead - coverage)
            risk = (f"Sem comprar agora, o saldo cobre cerca de {num(coverage)} dias, menos que o prazo de entrega "
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
    who = r["supplier"]["name"]
    action = (f"Simulação: comprar {num(r['qty'])} un. de {who} (prazo de teste, não confirmado por Compras)"
              if r.get("leadTimeStatus") == "teste" else f"Comprar {num(r['qty'])} un. de {who} (sugestão para revisão)")
    return {"rule": "R08", "type": "comprar", "action": action, "why": r["risk"], "evidence": r["evidence"],
            "limitations": r["limitations"]}


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
