"""Teste comparativo das semanas da previsão: motor antigo × novo sobre os MESMOS dados, em dias seguidos.

Antigo = o motor da produção (forecast-1.0.0: semanas que terminam no dia da análise). Novo = este pacote
(forecast-1.1.0: semanas de calendário, de segunda a domingo). Cada dia D simula a análise das 06:33 de D:
as vendas conhecidas são as anteriores a D (o próprio dia ainda não tem nota) e a fotografia dos produtos
(saldo, custo, curva, datas) é a mesma em todos os dias — só a data da análise e as vendas conhecidas
mudam, para isolar o efeito das semanas. De um dia para o outro, em cada versão, conta:
  - produtos que mudam de status da previsão (ok_<qualidade>, insuficiente, sem_vendas…), de modelo ou de
    taxa semanal;
  - oportunidades entre empresas que surgem, somem ou mudam de quantidade;
  - produtos que mudam de recomendações (com o planejamento do retrato: a produção ainda não tem
    fornecedores, então nenhuma sugestão de compra);
  - sugestões de compra que mudam num cenário SIMULADO, com um fornecedor de prazo de 30 dias para todos os
    produtos (só para medir o efeito na reposição; não é dado real);
  - e, de controle, o estado do produto (não depende da previsão: tem de mudar igual nas duas versões).

Uso (na pasta source/intelligence, com numpy e pandas):
  python tools/comparativo_semanas.py --saida <pasta>       # carteira sintética, 7 dias de 29/10 a 04/11
  python tools/comparativo_semanas.py --dados <retratos.json> --inicio 2026-10-29 --dias 7 --saida <pasta>
O motor antigo sai do git (--antigo-ref, padrão 2154e45 = o motor da release ativa cdb333a1f2a5), sem tocar
na pasta de trabalho. --dados tem o formato de carteira_sintetica.build(): params e, por empresa, o retorno
de stock_intel_extract (e o de stock_intel_planning, se houver).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import pathlib
import platform
import statistics
import subprocess
import sys
import tarfile
import tempfile
from datetime import date, timedelta
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
NEW_PKG = HERE.parent  # source/intelligence (contém biomie_intel)
SIM_SUPPLIER = "SIMULADO-30D"


# --------------------------------------------------------------------------- execução de uma versão

def day_extract(ex: dict[str, Any], day: date) -> dict[str, Any]:
    """O retrato como a análise das 06:33 de `day` o veria: vendas e devoluções dos 365 dias, até a véspera."""
    lo, hi = (day - timedelta(days=364)).isoformat(), day.isoformat()
    return {**ex, "asOf": hi,
            "sales": [r for r in ex.get("sales") or [] if lo <= str(r[1])[:10] < hi],
            "returns": [r for r in ex.get("returns") or [] if lo <= str(r[1])[:10] < hi]}


def simulated_planning(ex: dict[str, Any]) -> dict[str, Any]:
    return {"links": [[p["omieProductId"], SIM_SUPPLIER] for p in ex.get("products") or []],
            "leadTimes": [{"supplierId": SIM_SUPPLIER, "omie": None, "days": 30, "minLot": None, "status": "teste"}],
            "suppliers": {SIM_SUPPLIER: "Fornecedor simulado (30 dias)"}, "preferred": {}, "policy": None}


def run_version(pkg: str, data_file: str, days: list[str], out_file: str) -> None:
    sys.path.insert(0, pkg)
    import biomie_intel  # noqa: PLC0415 - a versão vem do caminho recebido
    from biomie_intel import forecast as fc  # noqa: PLC0415
    from biomie_intel.engine import build_company_rows  # noqa: PLC0415
    from biomie_intel.replenishment import index_entry, index_planning, opportunities, plan, resolve_supply  # noqa: PLC0415

    assert pathlib.Path(biomie_intel.__file__).resolve().is_relative_to(pathlib.Path(pkg).resolve())
    data = json.loads(pathlib.Path(data_file).read_text(encoding="utf-8"))
    params = data["params"]
    out: dict[str, Any] = {"engine": biomie_intel.VERSION, "forecast": fc.VERSION, "days": {}}
    for iso in days:
        day = date.fromisoformat(iso)
        products: dict[str, Any] = {}
        entries: list[dict[str, Any]] = []
        for comp in data["companies"]:
            ex = day_extract(comp["extract"], day)
            rows, _stats = build_company_rows(ex, params, comp.get("planning") or {})
            sim = index_planning(simulated_planning(ex))
            for row in rows:
                m, f = row["metrics"], row["metrics"]["forecast"]
                ok = f["status"] == "ok"
                buy = plan(m, row["state"], resolve_supply(sim, row["omieProductId"]), sim["policy"])
                products[f"{comp['slug']}|{row['omieProductId']}"] = {
                    "f": f"ok_{f['backtest']['quality']}" if ok else f["status"],
                    "model": f.get("model"), "rate": f.get("weeklyRate"),
                    "u30": f["horizons"]["30"]["units"] if ok else None,
                    "weeks": f.get("weeks"), "weekEnd": f["series"]["weekEnd"],
                    "state": row["state"],
                    "recs": sorted(f"{r.get('rule')}:{r['type']}" for r in m["recommendations"]),
                    "buy": [buy["status"], buy.get("qty")],
                }
            entries.extend(e for e in (index_entry(comp, r) for r in rows) if e is not None)
        opps = opportunities(entries, float(params["ruptureCoverageDays"]))
        out["days"][iso] = {"products": products, "opportunities": [
            {"key": f"{o['sku']}|{o['fromCompanyId']}|{o['fromOmie']}|{o['toCompanyId']}|{o['toOmie']}",
             "sku": o["sku"], "qty": o["qty"]} for o in opps]}
    pathlib.Path(out_file).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")


# --------------------------------------------------------------------------- comparação

def compare(res: dict[str, Any]) -> dict[str, Any]:
    days = sorted(res["days"])
    trans, changed_status, changed_any = [], set(), set()
    per_day = {}
    for iso in days:
        prods = res["days"][iso]["products"].values()
        counts: dict[str, int] = {}
        for p in prods:
            counts[p["f"]] = counts.get(p["f"], 0) + 1
        per_day[iso] = {"previsao": dict(sorted(counts.items())),
                        "oportunidades": len(res["days"][iso]["opportunities"]),
                        "compraSimulada": sum(1 for p in prods if p["buy"][0] == "comprar")}
    for a, b in zip(days, days[1:]):
        pa, pb = res["days"][a]["products"], res["days"][b]["products"]
        keys = sorted(set(pa) & set(pb))
        status = [k for k in keys if pa[k]["f"] != pb[k]["f"]]
        both_ok = [k for k in keys if pa[k]["f"].startswith("ok") and pb[k]["f"].startswith("ok")]
        rate = [k for k in both_ok if pa[k]["rate"] != pb[k]["rate"]]
        rel = [abs(pb[k]["rate"] - pa[k]["rate"]) / pa[k]["rate"] for k in rate if pa[k]["rate"]]
        oa = {o["key"]: o["qty"] for o in res["days"][a]["opportunities"]}
        ob = {o["key"]: o["qty"] for o in res["days"][b]["opportunities"]}
        row = {
            "de": a, "para": b,
            "statusPrevisao": len(status),
            "entrouOuSaiuDeOk": sum(1 for k in status if pa[k]["f"].startswith("ok") != pb[k]["f"].startswith("ok")),
            "modelo": sum(1 for k in both_ok if pa[k]["model"] != pb[k]["model"]),
            "taxa": len(rate),
            "taxaVariacaoMediana": round(statistics.median(rel), 3) if rel else None,
            "oportunidadesSurgiram": len(set(ob) - set(oa)), "oportunidadesSumiram": len(set(oa) - set(ob)),
            "oportunidadesMudaramQtd": sum(1 for k in set(oa) & set(ob) if oa[k] != ob[k]),
            "recomendacoes": sum(1 for k in keys if pa[k]["recs"] != pb[k]["recs"]),
            "compraSimulada": sum(1 for k in keys if pa[k]["buy"] != pb[k]["buy"]),
            "estadoControle": sum(1 for k in keys if pa[k]["state"] != pb[k]["state"]),
        }
        row["oportunidades"] = (row["oportunidadesSurgiram"] + row["oportunidadesSumiram"]
                                + row["oportunidadesMudaramQtd"])
        changed_status.update(status)
        changed_any.update(k for k in keys if (pa[k]["f"], pa[k]["rate"], pa[k]["model"])
                           != (pb[k]["f"], pb[k]["rate"], pb[k]["model"]))
        trans.append(row)
    fields = [k for k in trans[0] if k not in ("de", "para", "taxaVariacaoMediana")] if trans else []
    totals = {k: sum(t[k] for t in trans) for k in fields}
    totals["diasComMudancaDePrevisao"] = sum(1 for t in trans if t["statusPrevisao"] or t["taxa"] or t["modelo"])
    return {"engine": res["engine"], "forecast": res["forecast"], "porDia": per_day, "transicoes": trans,
            "totais": totals, "produtosQueMudaramDeStatus": len(changed_status),
            "produtosComPrevisaoAlterada": len(changed_any)}


def accuracy(results: dict[str, Any], data: dict[str, Any], days: list[str], horizon: int = 28) -> list[dict[str, Any]]:
    """Acerto da previsão de `horizon` dias feita em cada dia D contra o vendido de D a D + horizon − 1, nos
    produtos com previsão 'ok' nas duas versões (mesmo conjunto). Só dias com o período inteiro nos dados."""
    sold: dict[str, list[tuple[str, float]]] = {}
    last = ""
    for comp in data["companies"]:
        for omie, day, qty, *_rest in comp["extract"].get("sales") or []:
            sold.setdefault(f"{comp['slug']}|{omie}", []).append((str(day)[:10], float(qty)))
            last = max(last, str(day)[:10])
    last = data.get("salesUntil") or last  # na carteira sintética, até onde as vendas foram geradas
    out = []
    for iso in days:
        end = (date.fromisoformat(iso) + timedelta(days=horizon - 1)).isoformat()
        if end > last:
            continue
        old, new = (results[n]["days"][iso]["products"] for n in ("antigo", "novo"))
        keys = [k for k in old if k in new and old[k]["f"].startswith("ok") and new[k]["f"].startswith("ok")]
        actual = {k: sum(q for d, q in sold.get(k, []) if iso <= d <= end) for k in keys}
        total = sum(actual.values())
        row: dict[str, Any] = {"dia": iso, "produtos": len(keys), "vendido": round(total, 1)}
        for name, prods in (("antigo", old), ("novo", new)):
            err = sum(abs(prods[k]["rate"] * horizon / 7 - actual[k]) for k in keys)
            row[name] = {"wape": round(err / total, 3) if total else None,
                         "previsto": round(sum(prods[k]["rate"] * horizon / 7 for k in keys), 1)}
        out.append(row)
    return out


def same_day(results: dict[str, Any], days: list[str]) -> list[dict[str, Any]]:
    """Antigo × novo no MESMO dia: o que mudaria de uma vez se o novo fosse ativado naquele dia."""
    out = []
    for iso in days:
        old, new = (results[n]["days"][iso] for n in ("antigo", "novo"))
        po, pn = old["products"], new["products"]
        keys = [k for k in po if k in pn]
        oo = {o["key"]: o["qty"] for o in old["opportunities"]}
        on = {o["key"]: o["qty"] for o in new["opportunities"]}
        out.append({"dia": iso, "produtos": len(keys),
                    "statusPrevisao": sum(1 for k in keys if po[k]["f"] != pn[k]["f"]),
                    "entrouOuSaiuDeOk": sum(1 for k in keys if po[k]["f"].startswith("ok") != pn[k]["f"].startswith("ok")),
                    "oportunidades": len(set(oo) ^ set(on)) + sum(1 for k in set(oo) & set(on) if oo[k] != on[k]),
                    "compraSimulada": sum(1 for k in keys if po[k]["buy"] != pn[k]["buy"])})
    return out


def follow(res: dict[str, Any], key: str, sku: str) -> list[dict[str, Any]]:
    out = []
    for iso in sorted(res["days"]):
        p = res["days"][iso]["products"].get(key)
        opp = [o for o in res["days"][iso]["opportunities"] if o["sku"] == sku and o["key"].endswith(key.split("|")[1])]
        out.append({"dia": iso, "status": p["f"] if p else None, "semanas": p["weeks"] if p else None,
                    "oportunidade": opp[0]["qty"] if opp else None})
    return out


# --------------------------------------------------------------------------- orquestração

def git(*args: str, cwd: pathlib.Path = HERE) -> str:
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, check=True).stdout.strip()


def materialize(ref: str, dest: pathlib.Path) -> pathlib.Path:
    top = git("rev-parse", "--show-toplevel")
    blob = subprocess.run(["git", "-C", top, "archive", ref, "source/intelligence/biomie_intel"],
                          capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
        tar.extractall(dest, filter="data")
    return dest / "source" / "intelligence"


def markdown(report: dict[str, Any]) -> str:
    old, new = report["antigo"], report["novo"]
    lines = [f"# Comparativo das semanas da previsão — {report['dados']['descricao']}", "",
             f"Dias de análise: {', '.join(report['dias'])} (cada dia vê as vendas até a véspera; fotografia dos "
             "produtos fixa).", "",
             f"Antigo: {old['engine']} / {old['forecast']} (git {report['antigoRef']}). "
             f"Novo: {new['engine']} / {new['forecast']} (git {report['novoRef']}).", "",
             "## Mudanças de um dia para o outro (soma das transições)", "",
             "| Indicador | Antigo | Novo |", "|---|---:|---:|"]
    labels = {"statusPrevisao": "Produtos que mudaram de status da previsão",
              "entrouOuSaiuDeOk": "… dos quais entraram ou saíram de 'ok'",
              "modelo": "Produtos 'ok' que trocaram de modelo", "taxa": "Produtos 'ok' com taxa semanal diferente",
              "oportunidades": "Oportunidades entre empresas que surgiram, sumiram ou mudaram de quantidade",
              "recomendacoes": "Produtos com recomendações diferentes (planejamento do retrato)",
              "compraSimulada": "Sugestões de compra diferentes (cenário simulado, prazo 30 dias)",
              "estadoControle": "Controle: produtos que mudaram de estado (não depende da previsão)",
              "diasComMudancaDePrevisao": "Transições com alguma mudança na previsão"}
    for key, label in labels.items():
        lines.append(f"| {label} | {old['totais'][key]} | {new['totais'][key]} |")
    lines += [f"| Produtos diferentes que mudaram de status ao menos uma vez | {old['produtosQueMudaramDeStatus']} | "
              f"{new['produtosQueMudaramDeStatus']} |", "",
              "## Por transição (status da previsão / oportunidades / compra simulada)", "",
              "| De → para | Antigo | Novo |", "|---|---:|---:|"]
    for a, b in zip(old["transicoes"], new["transicoes"]):
        lines.append(f"| {a['de'][8:]}/{a['de'][5:7]} → {a['para'][8:]}/{a['para'][5:7]} | "
                     f"{a['statusPrevisao']} / {a['oportunidades']} / {a['compraSimulada']} | "
                     f"{b['statusPrevisao']} / {b['oportunidades']} / {b['compraSimulada']} |")
    lines += ["", "## Oportunidades por dia (antigo / novo)", "",
              " · ".join(f"{d[8:]}/{d[5:7]}: {old['porDia'][d]['oportunidades']} / {new['porDia'][d]['oportunidades']}"
                         for d in report["dias"])]
    if report.get("mesmoDia"):
        lines += ["", "## Antigo × novo no mesmo dia (mudança única no dia da ativação)", "",
                  "| Dia | Status da previsão diferente | Entrou/saiu de 'ok' | Oportunidades diferentes | "
                  "Compra simulada diferente |", "|---|---:|---:|---:|---:|"]
        for r in report["mesmoDia"]:
            lines.append(f"| {r['dia'][8:]}/{r['dia'][5:7]} | {r['statusPrevisao']} de {r['produtos']} | "
                         f"{r['entrouOuSaiuDeOk']} | {r['oportunidades']} | {r['compraSimulada']} |")
    if report.get("acerto28d"):
        lines += ["", "## Acerto da previsão de 28 dias (produtos 'ok' nas duas versões; erro = WAPE)", "",
                  "| Dia | Produtos | Vendido | Antigo: previsto · erro | Novo: previsto · erro |",
                  "|---|---:|---:|---|---|"]
        for r in report["acerto28d"]:
            lines.append(f"| {r['dia'][8:]}/{r['dia'][5:7]} | {r['produtos']} | {r['vendido']} | "
                         f"{r['antigo']['previsto']} · {r['antigo']['wape']} | {r['novo']['previsto']} · {r['novo']['wape']} |")
    if report.get("casoReal"):
        lines += ["", "## Caso real reproduzido: cadeira 00121 (Uni Design ← Mag Filial)", "",
                  "| Dia | Antigo: status · oportunidade | Novo: status · oportunidade |", "|---|---|---|"]
        for a, b in zip(report["casoReal"]["antigo"], report["casoReal"]["novo"]):
            lines.append(f"| {a['dia'][8:]}/{a['dia'][5:7]} | {a['status']} · {a['oportunidade'] or '—'} | "
                         f"{b['status']} · {b['oportunidade'] or '—'} |")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dados", help="retratos (JSON); sem ele, a carteira sintética")
    ap.add_argument("--semente", type=int, default=20261104)
    ap.add_argument("--inicio", default="2026-10-29")
    ap.add_argument("--dias", type=int, default=7)
    ap.add_argument("--antigo-ref", default="2154e45")
    ap.add_argument("--saida", required=True)
    ap.add_argument("--rodar", nargs=4, metavar=("PACOTE", "DADOS", "DIAS", "SAIDA"), help=argparse.SUPPRESS)
    args = ap.parse_args()
    if args.rodar:
        pkg, data_file, days, out_file = args.rodar
        run_version(pkg, data_file, days.split(","), out_file)
        return

    out_dir = pathlib.Path(args.saida)
    out_dir.mkdir(parents=True, exist_ok=True)
    start = date.fromisoformat(args.inicio)
    days = [(start + timedelta(days=i)).isoformat() for i in range(args.dias)]
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = pathlib.Path(tmp)
        if args.dados:
            data_file = pathlib.Path(args.dados)
            description = f"retratos de {data_file.name}"
        else:
            sys.path.insert(0, str(HERE))
            import carteira_sintetica  # noqa: PLC0415

            data_file = tmp_dir / "carteira.json"
            data_file.write_text(json.dumps(carteira_sintetica.build(args.semente), ensure_ascii=False),
                                 encoding="utf-8")
            description = f"carteira sintética (semente {args.semente}, composição real de 03/11)"
        digest = hashlib.sha256(data_file.read_bytes()).hexdigest()
        data = json.loads(data_file.read_text(encoding="utf-8"))
        old_pkg = materialize(args.antigo_ref, tmp_dir / "antigo")
        results = {}
        for name, pkg in (("antigo", old_pkg), ("novo", NEW_PKG)):
            target = tmp_dir / f"{name}.json"
            subprocess.run([sys.executable, str(pathlib.Path(__file__).resolve()), "--saida", str(out_dir),
                            "--rodar", str(pkg), str(data_file), ",".join(days), str(target)], check=True)
            results[name] = json.loads(target.read_text(encoding="utf-8"))
    head = git("rev-parse", "--short=12", "HEAD")
    dirty = bool(git("status", "--porcelain", "--", str(NEW_PKG)))
    report = {
        "dados": {"descricao": description, "sha256": digest, "semente": None if args.dados else args.semente},
        "dias": days, "antigoRef": git("rev-parse", "--short=12", args.antigo_ref),
        "novoRef": head + (" + alterações locais" if dirty else ""),
        "ambiente": {"python": platform.python_version(), "plataforma": platform.platform()},
        "antigo": compare(results["antigo"]), "novo": compare(results["novo"]),
        "acerto28d": accuracy(results, data, days),
        "mesmoDia": same_day(results, days),
    }
    real_key = "uni-design|8764749571"
    if all(real_key in results[n]["days"][days[0]]["products"] for n in results):
        report["casoReal"] = {n: follow(results[n], real_key, "00121") for n in results}
    (out_dir / "comparativo.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    (out_dir / "comparativo.md").write_text(markdown(report), encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # console do Windows (cp1252)
    print(markdown(report))


if __name__ == "__main__":
    main()
