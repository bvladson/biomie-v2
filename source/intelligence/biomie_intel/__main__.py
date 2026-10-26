"""Linha de comando do motor.

    python -m biomie_intel run [--trigger schedule|ops|test] [--force] [--company <slug|id>]

Ambiente: SUPABASE_URL (API interna), SUPABASE_SERVICE_ROLE_KEY (nunca impressa) e,
opcional, BIOMIE_INTEL_MAX_SECONDS (padrão 1200).
"""

from __future__ import annotations

import argparse
import os
import sys

from .api import RpcClient
from .engine import run


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="biomie_intel")
    sub = parser.add_subparsers(dest="command", required=True)
    run_cmd = sub.add_parser("run")
    run_cmd.add_argument("--trigger", choices=("schedule", "ops", "test"), default="schedule")
    run_cmd.add_argument("--force", action="store_true", help="roda mesmo com o motor desligado")
    run_cmd.add_argument("--company", help="só uma empresa (slug ou id)")
    args = parser.parse_args(argv)

    client = RpcClient(os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    try:
        result = run(client, trigger=args.trigger, force=args.force, company=args.company,
                     max_seconds=float(os.environ.get("BIOMIE_INTEL_MAX_SECONDS", "1200")))
    except Exception:  # noqa: BLE001 - a falha já foi registrada pelo motor
        return 1
    return 0 if result.get("published") or not result.get("started") else 1


if __name__ == "__main__":
    sys.exit(main())
