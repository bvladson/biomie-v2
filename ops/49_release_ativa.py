"""Release ativa na produção (SÓ LEITURA): o RELEASE_ID do stack.env, sem imprimir mais nada do arquivo.

    python ops/remote.py ops/49_release_ativa.py
"""
import json
import pathlib

env = pathlib.Path('/opt/biomie-v2/shared/stack.env').read_text()
release = next((line.split('=', 1)[1].strip() for line in env.splitlines() if line.startswith('RELEASE_ID=')), None)
print(json.dumps({'release': release}))
