import io
import json
import urllib.error

import pytest

from biomie_intel.api import RpcClient, RpcError
from biomie_intel.engine import CHUNK, build_company_rows, run
from test_metrics import PARAMS

KEY = "chave-de-servico-super-secreta"


def extract(n=950):
    products = [{"omieProductId": str(i), "productId": None, "sku": f"S{i}", "name": f"P{i}", "qty": 5,
                 "reserved": 0, "costMax": 10, "costMin": 10, "qtyPositive": 5, "capital": 50.0 + i,
                 "curve": "D", "curveSource": "auto", "daysWithoutSale": 200, "isNew": False} for i in range(n)]
    return {"companyId": "c1", "asOf": "2026-10-23", "salesFrom": "2026-01-01", "products": products,
            "sales": [["0", "2026-10-01", 2, 200, 1]], "returns": [["0", "2026-10-02", 1]], "curveHistory": []}


class FakeClient:
    def __init__(self, fail_on=None, started=True):
        self.calls = []
        self.fail_on = fail_on
        self.started = started

    def redact(self, text):
        return text.replace(KEY, "[oculto]")

    def call(self, name, args, retry=True):
        self.calls.append((name, args))
        if name == self.fail_on:
            raise RpcError(name, 500, "falha simulada " + KEY)
        if name == "stock_intel_begin":
            if not self.started:
                return {"started": False, "reason": "Motor de inteligência desligado."}
            return {"started": True, "runId": "r1", "asOf": "2026-10-23", "params": PARAMS, "newProductDays": 90,
                    "companies": [{"id": "c1", "slug": "mag-filial", "name": "MAG Filial"},
                                  {"id": "c2", "slug": "ergooffice", "name": "Ergo"}]}
        if name == "stock_intel_extract":
            return extract(950 if args["p_company"] == "c1" else 0)
        if name == "stock_intel_publish":
            return len(args["p_rows"])
        if name == "stock_intel_finish":
            return {"published": True, "companies": 1}
        return None


def test_rows_capital_rank_and_stats():
    rows, stats = build_company_rows(extract(3), PARAMS)
    assert stats["products"] == 3 and stats["withStock"] == 3
    assert rows[2]["priorityParts"]["capital"] == 1.0 and rows[0]["priorityParts"]["capital"] < 1.0
    assert all(r["state"] == "sem_venda_janela" for r in rows[1:])


def test_run_publishes_in_chunks_and_finishes_once():
    client = FakeClient()
    result = run(client, trigger="ops", log=lambda e: None)
    assert result["published"]
    publishes = [a for n, a in client.calls if n == "stock_intel_publish"]
    c1 = [a for a in publishes if a["p_company"] == "c1"]
    assert [a["p_chunk"] for a in c1] == list(range(-(-950 // CHUNK))) and sum(len(a["p_rows"]) for a in c1) == 950
    assert len(c1[0]["p_rows"]) == CHUNK
    # Empresa sem produtos ainda manda o lote 0 (limpa o que a execução tivesse gravado)
    assert [a["p_chunk"] for a in publishes if a["p_company"] == "c2"] == [0]
    assert [n for n, _ in client.calls].count("stock_intel_finish") == 1
    assert "stock_intel_fail" not in [n for n, _ in client.calls]


def test_failure_marks_run_failed_without_publishing_and_hides_key():
    client = FakeClient(fail_on="stock_intel_extract")
    events = []
    with pytest.raises(RpcError):
        run(client, log=events.append)
    names = [n for n, _ in client.calls]
    assert "stock_intel_fail" in names and "stock_intel_finish" not in names
    fail_args = [a for n, a in client.calls if n == "stock_intel_fail"][0]
    assert KEY not in fail_args["p_error"] and KEY not in json.dumps(events)


def test_disabled_engine_is_skipped():
    client = FakeClient(started=False)
    result = run(client, log=lambda e: None)
    assert result == {"started": False, "reason": "Motor de inteligência desligado."}
    assert [n for n, _ in client.calls] == ["stock_intel_begin"]


def test_company_filter():
    client = FakeClient()
    run(client, company="ergooffice", log=lambda e: None)
    extracted = [a["p_company"] for n, a in client.calls if n == "stock_intel_extract"]
    assert extracted == ["c2"]


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_api_retries_only_idempotent_calls_and_never_leaks_the_key():
    attempts = []

    def opener(request, timeout):
        attempts.append(request.full_url)
        assert request.headers["Apikey"] == KEY  # vai no cabeçalho, nunca na mensagem
        raise urllib.error.HTTPError(request.full_url, 503, "x", {}, io.BytesIO(("erro " + KEY).encode()))

    client = RpcClient("http://gateway:8000", KEY, retries=2, sleep=lambda s: None, opener=opener)
    with pytest.raises(RpcError) as info:
        client.call("stock_intel_extract", {"p_run": "r"})
    assert len(attempts) == 3 and KEY not in str(info.value)
    attempts.clear()
    with pytest.raises(RpcError):
        client.call("stock_intel_begin", {}, retry=False)
    assert len(attempts) == 1


def test_api_returns_json():
    client = RpcClient("http://gateway:8000/", KEY, opener=lambda r, timeout: FakeResponse(b'{"ok": true}'))
    assert client.call("stock_intel_status", {}) == {"ok": True}
