"""Cliente das funções do BIOMIE pela API interna (PostgREST), com a chave de serviço.

A chave nunca aparece em mensagens, logs ou exceções. Só as chamadas idempotentes são repetidas
em falha temporária (erro 5xx ou de rede).
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import Any, Callable

_NAME = re.compile(r"^[a-z_]{3,60}$")


class RpcError(Exception):
    def __init__(self, name: str, status: int, message: str):
        super().__init__(f"{name}: HTTP {status}: {message}")
        self.name = name
        self.status = status
        self.message = message


class RpcClient:
    def __init__(
        self,
        base_url: str,
        key: str,
        timeout: float = 300.0,
        retries: int = 2,
        sleep: Callable[[float], None] = time.sleep,
        opener: Callable[..., Any] = urllib.request.urlopen,
    ):
        if not base_url or not key:
            raise ValueError("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.")
        self._base = base_url.rstrip("/") + "/rest/v1/rpc/"
        self._key = key
        self._timeout = timeout
        self._retries = retries
        self._sleep = sleep
        self._open = opener

    def redact(self, text: str) -> str:
        return text.replace(self._key, "[oculto]") if self._key else text

    def call(self, name: str, args: dict[str, Any], retry: bool = True) -> Any:
        if not _NAME.match(name):
            raise ValueError("Nome de função inválido.")
        body = json.dumps(args, default=str).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "apikey": self._key,
            "Authorization": "Bearer " + self._key,
        }
        attempt = 0
        while True:
            request = urllib.request.Request(self._base + name, data=body, method="POST", headers=headers)
            try:
                with self._open(request, timeout=self._timeout) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as error:
                detail = self.redact(error.read().decode("utf-8", "replace")[:300])
                if retry and error.code >= 500 and attempt < self._retries:
                    attempt += 1
                    self._sleep(5 * attempt)
                    continue
                raise RpcError(name, error.code, detail) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
                if retry and attempt < self._retries:
                    attempt += 1
                    self._sleep(5 * attempt)
                    continue
                raise RpcError(name, 0, self.redact(str(error))[:200]) from None
