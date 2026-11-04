"""Previsão de demanda por produto e empresa (fase 4): 30, 60 e 90 dias.

Base: vendas diárias do BIOMIE (fact_sales, a mesma base da página Produtos), somadas em semanas de
calendário completas, de segunda a domingo (versão 1.1, 04/11/2026; até a 1.0 as semanas terminavam no
dia da análise e mudavam de fronteira todo dia, então as mesmas vendas trocavam de semana de um dia para
o outro e a previsão oscilava sem venda nova).
  - A última semana é a que terminou no domingo anterior ao dia da análise. A semana em curso (da
    segunda-feira até o dia da análise) fica de fora — inclusive num domingo, porque o motor roda às
    06:33 e o dia ainda não terminou; ela entra na segunda-feira seguinte, já completa. Assim a série,
    o modelo e o status ficam iguais de segunda a domingo e só mudam quando uma semana nova se completa;
    o custo é até 6 dias de atraso para uma venda nova pesar na previsão (o campo openWeek diz quais dias
    ficaram de fora).
  - A primeira semana começa na primeira segunda-feira a partir do início das vendas no BIOMIE. Semana
    parcial no início e semanas anteriores são desconhecidas e ficam de fora (nunca viram zero).

Modelos (todos determinísticos, do mais simples ao mais elaborado):
  media_13s   média das últimas 13 semanas (≈ 90 dias) — a base de comparação;
  media_total média de todas as semanas observadas;
  ses         suavização exponencial simples; o alfa (0,1, 0,2 ou 0,3) é escolhido em cada ponto do
              teste só com o passado (menor erro de um passo até ali);
  croston     Croston (alfa 0,1), para demanda intermitente;
  sba         Croston com a correção de Syntetos–Boylan (× (1 − alfa/2));
  tsb         Teunter–Syntetos–Babai (alfa 0,1, beta 0,1): probabilidade de venda × tamanho médio.
Cada modelo devolve uma taxa semanal; a previsão de N dias = taxa × N/7.

Teste histórico (origem móvel, sem vazamento): em cada semana de corte o modelo usa só as semanas
anteriores e prevê o total das 4, 9 e 13 semanas seguintes (≈ 30, 60 e 90 dias). Escolhe-se o modelo
com menor erro absoluto médio no horizonte de 4 semanas; empate fica com o mais simples.
Métricas: erro absoluto médio (un.), WAPE = soma dos erros ÷ soma do vendido (sem venda no teste:
não avaliável, nunca divisão por zero), viés (relativo ao vendido) e ganho sobre a base
(1 − erro do modelo ÷ erro da média de 13 semanas). Qualidade: boa (WAPE ≤ 30%), regular (≤ 60%) ou
fraca — rótulo das métricas, não probabilidade.
Faixa inferior/superior: quantis 10% e 90% dos erros do próprio teste em cada horizonte, só com pelo
menos 10 cortes; é a faixa dos erros observados no passado, não um intervalo de confiança calibrado.
Sem previsão (e a tela diz por quê): produto novo; menos de 12 semanas observadas, menos de 3 semanas
com venda ou menos de 6 cortes de teste ("Histórico insuficiente para previsão confiável."); nenhuma
venda no histórico; nenhuma venda nas últimas 26 semanas.
Classe da demanda (Syntetos–Boylan): ADI = semanas ÷ semanas com venda; CV² do tamanho das vendas;
frequente (ADI < 1,32 e CV² < 0,49), intermitente (ADI ≥ 1,32), irregular (CV² ≥ 0,49) ou esporádica
(os dois). Sazonalidade só com 2 anos de histórico: até lá, "não avaliável".
Limitação: não há histórico diário de saldo por produto, então semanas sem venda podem ter sido falta
de estoque; com o produto hoje sem saldo, a demanda recente pode estar reprimida (aviso na previsão).
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Callable

import numpy as np

VERSION = "forecast-1.1.0"
HORIZON_DAYS = (30, 60, 90)
HORIZON_WEEKS = {30: 4, 60: 9, 90: 13}
MODELS = ("media_13s", "media_total", "ses", "croston", "sba", "tsb")
MODEL_LABELS = {"media_13s": "Média das últimas 13 semanas", "media_total": "Média do histórico",
                "ses": "Suavização exponencial simples", "croston": "Croston (demanda intermitente)",
                "sba": "Croston com correção de Syntetos–Boylan", "tsb": "Teunter–Syntetos–Babai"}
MIN_WEEKS, MIN_NONZERO, MIN_ORIGINS, MIN_TRAIN, INTERVAL_ORIGINS, IDLE_WEEKS = 12, 3, 6, 8, 10, 26
ALPHA, BETA, SES_ALPHAS = 0.1, 0.1, (0.1, 0.2, 0.3)
INSUFFICIENT = "Histórico insuficiente para previsão confiável."
SERIES_WEEKS = 26


def last_week_end(as_of: date) -> date:
    """Domingo em que terminou a última semana completa: o anterior ao dia da análise, mesmo num domingo."""
    return as_of - timedelta(days=as_of.weekday() + 1)


def weekly_series(sales: list[tuple[date, float]], as_of: date, sales_from: date | None) -> tuple[np.ndarray, date | None]:
    """Semanas de calendário (segunda a domingo) completas e observadas, da mais antiga para a mais recente.

    A última termina em last_week_end(as_of); devolve também a segunda-feira em que começa a primeira."""
    if sales_from is None or sales_from > as_of:
        return np.zeros(0), None
    end = last_week_end(as_of)
    first = sales_from + timedelta(days=(7 - sales_from.weekday()) % 7)  # 1ª segunda-feira com vendas no BIOMIE
    weeks = max(0, ((end - first).days + 1) // 7)
    y = np.zeros(weeks)
    for day, qty in sales:
        k = (end - day).days // 7  # depois de end (semana em curso) dá negativo e fica de fora
        if 0 <= k < weeks and qty:
            y[weeks - 1 - k] += float(qty)
    return y, first if weeks else None


def _mean_rates(y: np.ndarray, window: int | None) -> np.ndarray:
    """Taxa em cada origem o (usa y[:o]); índice o = 0..n. Origem sem passado = nan."""
    n = len(y)
    cs = np.concatenate([[0.0], np.cumsum(y)])
    out = np.full(n + 1, np.nan)
    for o in range(1, n + 1):
        lo = 0 if window is None else max(0, o - window)
        out[o] = (cs[o] - cs[lo]) / (o - lo)
    return out


def _ses_rates(y: np.ndarray) -> np.ndarray:
    """SES com o alfa escolhido em cada origem pelo menor erro de um passo dentro do passado."""
    n = len(y)
    out = np.full(n + 1, np.nan)
    levels = {a: None for a in SES_ALPHAS}
    errors = {a: 0.0 for a in SES_ALPHAS}
    for o in range(1, n + 1):
        value = y[o - 1]
        for a in SES_ALPHAS:
            level = levels[a]
            if level is None:
                levels[a] = value
            else:
                errors[a] += abs(value - level)
                levels[a] = a * value + (1 - a) * level
        best = min(SES_ALPHAS, key=lambda a: (errors[a], a))
        out[o] = levels[best]
    return out


def _croston_rates(y: np.ndarray, sba: bool) -> np.ndarray:
    n = len(y)
    out = np.full(n + 1, np.nan)
    size, interval, since = None, None, 0
    for o in range(1, n + 1):
        value = y[o - 1]
        since += 1
        if value > 0:
            if size is None:
                size, interval = value, float(since)
            else:
                size = size + ALPHA * (value - size)
                interval = interval + ALPHA * (since - interval)
            since = 0
        if size is None:
            out[o] = 0.0
        else:
            rate = size / interval
            out[o] = rate * (1 - ALPHA / 2) if sba else rate
    return out


def _tsb_rates(y: np.ndarray) -> np.ndarray:
    n = len(y)
    out = np.full(n + 1, np.nan)
    prob, size = None, None
    for o in range(1, n + 1):
        value = y[o - 1]
        hit = 1.0 if value > 0 else 0.0
        if prob is None:
            prob = hit
            size = value if value > 0 else None
        else:
            prob = prob + BETA * (hit - prob)
            if value > 0:
                size = value if size is None else size + ALPHA * (value - size)
        out[o] = 0.0 if size is None else prob * size
    return out


RATES: dict[str, Callable[[np.ndarray], np.ndarray]] = {
    "media_13s": lambda y: _mean_rates(y, 13),
    "media_total": lambda y: _mean_rates(y, None),
    "ses": _ses_rates,
    "croston": lambda y: _croston_rates(y, sba=False),
    "sba": lambda y: _croston_rates(y, sba=True),
    "tsb": _tsb_rates,
}


def origin_rates(y: np.ndarray) -> dict[str, np.ndarray]:
    """Para cada modelo, a taxa semanal prevista em cada origem (só com o passado daquela origem)."""
    return {name: RATES[name](y) for name in MODELS}


def demand_class(y: np.ndarray) -> tuple[str | None, float | None, float | None]:
    nonzero = y[y > 0]
    if len(nonzero) == 0:
        return None, None, None
    adi = len(y) / len(nonzero)
    cv2 = float((nonzero.std() / nonzero.mean()) ** 2) if len(nonzero) > 1 else 0.0
    if adi < 1.32:
        label = "frequente" if cv2 < 0.49 else "irregular"
    else:
        label = "intermitente" if cv2 < 0.49 else "esporadica"
    return label, round(adi, 2), round(cv2, 3)


def _quality(wape: float | None) -> str:
    if wape is None:
        return "nao_avaliavel"
    return "boa" if wape <= 0.30 else "regular" if wape <= 0.60 else "fraca"


def backtest(y: np.ndarray, rates: dict[str, np.ndarray], weeks: int) -> dict[str, dict[str, Any]]:
    """Erros (real − previsto) do total das `weeks` semanas seguintes a cada origem, por modelo."""
    n = len(y)
    cs = np.concatenate([[0.0], np.cumsum(y)])
    origins = list(range(MIN_TRAIN, n - weeks + 1))
    out: dict[str, dict[str, Any]] = {}
    for name, rate in rates.items():
        actual = np.array([cs[o + weeks] - cs[o] for o in origins])
        predicted = np.array([rate[o] * weeks for o in origins])
        out[name] = {"origins": origins, "actual": actual, "predicted": predicted, "errors": actual - predicted}
    return out


def _metrics(bt: dict[str, Any]) -> dict[str, Any]:
    errors, actual = bt["errors"], bt["actual"]
    if len(errors) == 0:
        return {"mae": None, "wape": None, "bias": None}
    total = float(actual.sum())
    mae = float(np.abs(errors).mean())
    wape = float(np.abs(errors).sum() / total) if total > 0 else None
    bias = float(-errors.sum() / total) if total > 0 else None  # > 0: previsão acima do real
    return {"mae": mae, "wape": wape, "bias": bias}


def forecast(m: dict[str, Any], sales: list[tuple[date, float]], as_of: date, sales_from: date | None) -> dict[str, Any]:
    y, first = weekly_series(sales, as_of, sales_from)
    end = last_week_end(as_of)
    nonzero = int((y > 0).sum())
    label, adi, cv2 = demand_class(y)
    limitations = ["Não há histórico diário de saldo por produto: semanas sem venda podem ter sido falta de estoque."]
    if (m["stock"]["available"] or 0) <= 0:
        limitations.append("Produto sem saldo disponível hoje: a demanda recente pode estar reprimida.")
    base: dict[str, Any] = {
        "version": VERSION, "computedFor": as_of.isoformat(), "weeks": len(y), "nonzeroWeeks": nonzero,
        "trainFrom": first.isoformat() if first else None, "trainTo": end.isoformat() if len(y) else None,
        # semana em curso: estes dias ainda não contam (entram na segunda-feira seguinte)
        "openWeek": {"from": (end + timedelta(days=1)).isoformat(), "to": as_of.isoformat()},
        "demandClass": label, "adi": adi, "cv2": cv2,
        "seasonality": "nao_avaliavel" if len(y) < 104 else "nao_calculada",
        "limitations": limitations,
        "series": {"weekEnd": end.isoformat(), "actual": [round(float(v), 3) for v in y[-SERIES_WEEKS:]]},
    }

    def stop(status: str, message: str) -> dict[str, Any]:
        return {**base, "status": status, "message": message}

    if m.get("isNew"):
        return stop("novo", "Produto novo: ainda sem histórico para prever a demanda.")
    if len(y) < MIN_WEEKS:
        return stop("insuficiente", INSUFFICIENT)
    if nonzero == 0:
        return stop("sem_vendas", "Sem vendas no histórico observado: não há demanda para prever.")
    if float(y[-IDLE_WEEKS:].sum()) == 0:
        return stop("sem_vendas_prolongadas", "Sem vendas nas últimas 26 semanas: previsão suspensa.")
    if nonzero < MIN_NONZERO or len(y) - HORIZON_WEEKS[30] + 1 - MIN_TRAIN < MIN_ORIGINS:
        return stop("insuficiente", INSUFFICIENT)

    rates = origin_rates(y)
    bt30 = backtest(y, rates, HORIZON_WEEKS[30])
    maes = {name: _metrics(bt30[name])["mae"] for name in MODELS}
    best = min(MODELS, key=lambda name: (round(maes[name], 9), MODELS.index(name)))
    chosen = _metrics(bt30[best])
    base_mae = maes["media_13s"]
    rate = float(rates[best][len(y)])
    std = float(y.std())

    horizons: dict[str, Any] = {}
    interval_ok = len(bt30[best]["origins"]) >= INTERVAL_ORIGINS
    for days in HORIZON_DAYS:
        weeks = HORIZON_WEEKS[days]
        point = rate * days / 7
        item: dict[str, Any] = {"units": round(point, 2)}
        bt = bt30 if days == 30 else backtest(y, {best: rates[best]}, weeks)
        errors = bt[best]["errors"]
        if interval_ok and len(errors) >= INTERVAL_ORIGINS:
            scale = days / (7 * weeks)
            q10, q90 = (float(v) for v in np.quantile(errors, [0.1, 0.9]))
            low = max(0.0, point + q10 * scale)
            item["low"] = round(low, 2)
            item["high"] = round(max(low, point + q90 * scale), 2)
        metrics = _metrics(bt[best])
        item["wape"] = None if metrics["wape"] is None else round(metrics["wape"], 3)
        item["origins"] = len(errors)
        horizons[str(days)] = item

    origins = bt30[best]["origins"]
    # previsão de um passo para cada uma das últimas semanas (feita só com as semanas anteriores a ela)
    fitted = [round(float(rates[best][w]), 3) if w >= 1 else None
              for w in range(max(0, len(y) - SERIES_WEEKS), len(y))]
    return {
        **base, "status": "ok", "message": None, "model": best, "modelLabel": MODEL_LABELS[best],
        "weeklyRate": round(rate, 4), "weeklyStd": round(std, 4), "dailyRate": round(rate / 7, 4),
        "horizons": horizons,
        "intervalBasis": "Faixa dos erros do teste histórico (10% a 90%)" if interval_ok else None,
        "backtest": {
            "origins": len(origins), "horizonWeeks": HORIZON_WEEKS[30],
            "mae": round(chosen["mae"], 3), "wape": None if chosen["wape"] is None else round(chosen["wape"], 3),
            "bias": None if chosen["bias"] is None else round(chosen["bias"], 3),
            "skillVsBase": None if not base_mae else round(1 - chosen["mae"] / base_mae, 3),
            "quality": _quality(chosen["wape"]),
            "models": {name: round(maes[name], 3) for name in MODELS},
        },
        "series": {**base["series"], "fitted": fitted},
    }
