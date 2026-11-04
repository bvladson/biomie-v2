"""Carteira sintética para o teste comparativo das semanas da previsão (tools/comparativo_semanas.py).

Imita a composição da análise de 03/11/2026 na cópia: 5 empresas e 1.497 produtos (Mag Filial 1.111,
Ergo Office 209, Uni Design 98, Expert 58, Mag Matriz 21), vendas no BIOMIE desde 01/01/2026, a mesma
proporção de produtos sem venda, parados, raros, ativos e novos, e as mesmas SKUs em mais de uma empresa
(é o que gera as oportunidades entre empresas). Os pedidos caem em dias úteis e às vezes saem em notas de
dias seguidos (entrega parcial): é o caso em que duas vendas mudam de semana quando a fronteira da semana
anda com o dia da análise.

Nada vem da produção: códigos, nomes, quantidades e valores são inventados, com semente fixa (o mesmo
arquivo sempre). Calibração (motor da produção, análise de 03/11, semente 20261104): insuficiente 268,
novo 121, ok 334 (fraca 325, regular 9), sem vendas 542, sem vendas há 26 semanas 234 e 24 oportunidades —
na cópia real de 03/11: 275, 124, 334 (325, 9), 558, 206 e 21. Inclui um produto com o histórico da cadeira 00121 da Uni Design (3 vendas em 10 meses,
duas com dias de diferença, sobra de 3 un. na Mag Filial), o caso que mudou de 03 para 04/11.
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from typing import Any

import numpy as np

SALES_FROM = date(2026, 1, 1)
SNAPSHOT = date(2026, 11, 4)  # fotografia dos produtos (saldo, custo, datas) usada em todos os dias
LAST_DAY = date(2026, 11, 30)  # vendas geradas até aqui (cada dia simulado só vê as anteriores a ele)
PARAMS = {"minHistoryDays": 120, "lowTurnoverAnnual": 1.0, "excessCoverageDays": 180, "obsolescenceDays": 365,
          "ruptureCoverageDays": 15, "trendDeclinePct": -30, "costSuspectMax": 1.0, "runsKeptDays": 14,
          "priorityWeights": {"capital": 0.4, "idle": 0.3, "coverage": 0.15, "trend": 0.15}}

# slug, nome, produtos, com saldo, perfis (fração), SKUs em comum com a Mag Filial
COMPANIES = (
    ("mag-filial", "Mag Filial (sintética)", 1111, 0.81,
     {"novo": 0.085, "nunca": 0.405, "antigo": 0.10, "raro": 0.26, "ativo": 0.15}, 0.0),
    ("ergooffice", "Ergo Office (sintética)", 209, 0.37,
     {"novo": 0.10, "nunca": 0.30, "antigo": 0.13, "raro": 0.36, "ativo": 0.11}, 0.25),
    ("uni-design", "Uni Design (sintética)", 98, 0.03,
     {"novo": 0.08, "nunca": 0.10, "antigo": 0.0, "raro": 0.66, "ativo": 0.16}, 0.60),
    ("expert", "Expert (sintética)", 58, 0.035,
     {"novo": 0.02, "nunca": 0.15, "antigo": 0.19, "raro": 0.49, "ativo": 0.15}, 0.30),
    ("mag-matriz", "Mag Matriz (sintética)", 21, 1.0, {"nunca": 1.0}, 0.50),
)
WEEKDAY_WEIGHTS = np.array([0.20, 0.22, 0.22, 0.20, 0.14, 0.02, 0.0])  # segunda a domingo


def _business_day(rng: np.random.Generator, start: date, end: date) -> date:
    """Um dia entre start e end com o peso do dia da semana (vendas B2B: quase nada no fim de semana)."""
    span = (end - start).days + 1
    days = [start + timedelta(days=i) for i in range(span)]
    weights = np.array([WEEKDAY_WEIGHTS[d.weekday()] for d in days])
    return days[int(rng.choice(span, p=weights / weights.sum()))]


def _events(rng: np.random.Generator, count: int, start: date, end: date, size: float) -> list[tuple[date, float]]:
    out: list[tuple[date, float]] = []
    for _ in range(count):
        day = _business_day(rng, start, end)
        qty = max(1, int(round(math.exp(rng.normal(math.log(size), 1.0)))))
        if qty >= 2 and rng.random() < 0.3:  # entrega parcial: parte sai em nota 1 a 3 dias depois
            later = day + timedelta(days=int(rng.integers(1, 4)))
            part = int(rng.integers(1, qty))
            out.append((later, float(part)))
            qty -= part
        out.append((day, float(qty)))
    return out


def _sales_for(rng: np.random.Generator, profile: str) -> list[tuple[date, float]]:
    size = float(rng.choice([1.0, 1.0, 1.5, 2.5, 4.0, 8.0]))
    if profile == "nunca":
        return []
    if profile == "antigo":  # só no começo do ano: mais de 26 semanas sem venda
        return _events(rng, int(rng.integers(1, 7)), SALES_FROM, date(2026, 4, 20), size)
    if profile == "raro":
        count = int(rng.choice([1, 2, 3, 4], p=[0.4, 0.35, 0.17, 0.08]))
        return _events(rng, count, date(2026, 3, 1), LAST_DAY, size)
    if profile == "novo":
        if rng.random() < 0.5:
            return []
        return _events(rng, int(rng.integers(1, 5)), SNAPSHOT - timedelta(days=60), LAST_DAY, size)
    weekly = float(rng.uniform(0.05, 0.6))  # ativo: pedidos por semana
    weeks = (LAST_DAY - SALES_FROM).days / 7
    return _events(rng, max(4, int(rng.poisson(weekly * weeks))), SALES_FROM, LAST_DAY, size)


def _product(rng: np.random.Generator, omie: str, sku: str, name: str, profile: str, with_stock: bool,
             sales: list[tuple[date, float]]) -> dict[str, Any]:
    cost = float(round(rng.uniform(40, 1800), 2))
    price = round(cost * float(rng.uniform(1.4, 2.4)), 2)
    if profile == "nunca" and not with_stock:  # o retrato só traz produto com saldo ou com venda
        qty = -float(rng.integers(1, 4))
    elif with_stock:
        qty = float(max(1, int(round(math.exp(rng.normal(2.2, 1.0))))))
    else:
        qty = 0.0 if rng.random() < 0.85 else -float(rng.integers(1, 4))
    known = [d for d, _q in sales if d < SNAPSHOT]
    last = max(known) if known else None
    idle = (SNAPSHOT - last).days if last else (SNAPSHOT - SALES_FROM).days - int(rng.integers(0, 60))
    revenue = round(sum(q for d, q in sales if SNAPSHOT - timedelta(days=364) <= d < SNAPSHOT) * price, 2)
    is_new = profile == "novo"
    return {
        "omieProductId": omie, "productId": None, "sku": sku, "name": name, "family": "Sintética",
        "qty": qty, "reserved": 0, "pending": float(rng.integers(1, 6)) if rng.random() < 0.05 else 0,
        "minQty": float(rng.integers(1, 4)) if rng.random() < 0.1 else 0,
        "costMax": cost, "costMin": cost, "qtyPositive": max(qty, 0.0),
        "capital": round(qty * cost, 2) if qty > 0 else None, "negativeValue": round(qty * cost, 2) if qty < 0 else None,
        "negativePositions": 1 if qty < 0 else 0, "locations": 1, "salePrice": price,
        "curve": "D", "curveSource": "auto", "revenue12m": revenue, "share12m": None,
        "lastSale": last.isoformat() if last else None, "daysWithoutSale": idle,
        "idleSince": last.isoformat() if last else None, "isNew": is_new,
        "registeredAt": (SNAPSHOT - timedelta(days=int(rng.integers(5, 80)))).isoformat() if is_new else None,
        "arrivedOn": None, "incompleteReason": None, "elsewhereCompany": None, "elsewhereLastSale": None,
        "curveWindowStart": (SNAPSHOT - timedelta(days=364)).isoformat(), "prevUnitCost": cost,
        "received30": 0.0, "received90": 0.0,
    }


def _curves(products: list[dict[str, Any]]) -> None:
    """Curva A/B/C/D pelo faturamento acumulado da empresa (50/80/95%); sem faturamento = D."""
    ranked = sorted((p for p in products if p["revenue12m"] > 0), key=lambda p: -p["revenue12m"])
    total = sum(p["revenue12m"] for p in ranked) or 1.0
    acc = 0.0
    for p in ranked:
        acc += p["revenue12m"]
        share = acc / total
        p["share12m"] = round(p["revenue12m"] / total, 6)
        p["curve"] = "A" if share <= 0.5 else "B" if share <= 0.8 else "C" if share <= 0.95 else "D"


def build(seed: int = 20261104) -> dict[str, Any]:
    rng = np.random.default_rng(seed)
    filial_skus: list[tuple[str, str]] = []
    companies = []
    for index, (slug, name, count, stock_ratio, profiles, shared) in enumerate(COMPANIES):
        kinds = list(profiles)
        products, sales_rows = [], []
        for i in range(count):
            omie = f"{9 + index}{i:06d}"
            if slug == "mag-filial":
                sku, pname = f"S{i:05d}", f"Produto sintético {i:05d}"
                filial_skus.append((sku, pname))
            elif rng.random() < shared:
                sku, pname = filial_skus[int(rng.integers(0, len(filial_skus)))]
            else:
                sku, pname = f"{slug[:2].upper()}{i:05d}", f"Produto sintético {slug[:2].upper()}{i:05d}"
            profile = str(rng.choice(kinds, p=[profiles[k] for k in kinds]))
            sales = _sales_for(rng, profile)
            products.append(_product(rng, omie, sku, pname, profile, rng.random() < stock_ratio, sales))
            daily: dict[date, float] = {}
            for day, qty in sales:
                daily[day] = daily.get(day, 0.0) + qty
            price = products[-1]["salePrice"]
            sales_rows += [[omie, d.isoformat(), q, round(q * price, 2), 1] for d, q in sorted(daily.items())]
        companies.append({"id": f"00000000-0000-0000-0000-00000000000{index + 1}", "slug": slug, "name": name,
                          "products": products, "sales": sales_rows})
    _real_case(companies)
    for c in companies:
        _curves(c["products"])
    return {"kind": "sintetica", "seed": seed, "snapshot": SNAPSHOT.isoformat(), "params": PARAMS,
            "salesUntil": LAST_DAY.isoformat(),
            "companies": [{"id": c["id"], "slug": c["slug"], "name": c["name"], "planning": {},
                           "extract": {"companyId": c["id"], "asOf": SNAPSHOT.isoformat(),
                                       "salesFrom": SALES_FROM.isoformat(), "products": c["products"],
                                       "sales": sorted(c["sales"], key=lambda r: (r[0], r[1])),
                                       "returns": [], "curveHistory": []}}
                          for c in companies]}


def _real_case(companies: list[dict[str, Any]]) -> None:
    """Cadeira 00121: na Uni Design 3 vendas (12/06, 17/06 e 14/08; o dia exato da 1ª é um de 11 a 16/06) e
    saldo −3; na Mag Filial 3 un. paradas há 82 dias (sobra). Em 03/11 havia oportunidade; em 04/11, não."""
    by = {c["slug"]: c for c in companies}
    rng = np.random.default_rng(121)
    uni = _product(rng, "8764749571", "00121", "Cadeira (caso real 00121)", "raro", False,
                   [(date(2026, 6, 12), 1.0), (date(2026, 6, 17), 1.0), (date(2026, 8, 14), 1.0)])
    uni.update(qty=-3.0, qtyPositive=0.0, capital=None, negativePositions=1)
    by["uni-design"]["products"].append(uni)
    by["uni-design"]["sales"] += [[uni["omieProductId"], d, 1.0, uni["salePrice"], 1]
                                  for d in ("2026-06-12", "2026-06-17", "2026-08-14")]
    filial = _product(rng, "8764000121", "00121", "Cadeira (caso real 00121)", "nunca", True, [])
    filial.update(qty=3.0, qtyPositive=3.0, capital=round(3 * filial["costMax"], 2), lastSale="2026-08-14",
                  daysWithoutSale=82, idleSince="2026-08-14")
    by["mag-filial"]["products"].append(filial)
    # 1 venda em 14/08 na Filial (janela de 365 dias com venda, cobertura alta = possível excesso)
    by["mag-filial"]["sales"].append([filial["omieProductId"], "2026-08-14", 1.0, filial["salePrice"], 1])
