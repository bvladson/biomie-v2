#!/usr/bin/env python3
"""Host-side helper for the BIOMIE v2 stack (Python 3 stdlib only).

Never prints secret values. Writes secrets atomically with mode 0600.

  stackctl.py render-gateway            render shared/gateway.conf from the template
  stackctl.py rotate-jwt                new JWT secret + anon/service keys (old ones die)
  stackctl.py ensure-secret NAME        create a random 32-byte hex secret if missing
  stackctl.py set NAME=VALUE [...]      set non-secret settings (RELEASE_ID, ...)
  stackctl.py check                     validate stack.env without printing values
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import sys
import time

BASE = pathlib.Path(os.environ.get("BIOMIE_V2_BASE", "/opt/biomie-v2"))
ENV_PATH = BASE / "shared" / "stack.env"
GATEWAY_PATH = BASE / "shared" / "gateway.conf"
HERE = pathlib.Path(__file__).resolve().parent
TEMPLATE = HERE / "gateway.conf.template"

SECRET_NAMES = {
    "POSTGRES_PASSWORD", "AUTH_DB_PASSWORD", "REST_DB_PASSWORD", "JWT_SECRET", "ANON_KEY",
    "SERVICE_ROLE_KEY", "BIOMIE_JOB_TOKEN", "BIOMIE_CREDENTIALS_KEY", "SMTP_PASS",
}
NON_SECRET_SETTABLE = {"RELEASE_ID", "SOURCE_DIR", "BIOMIE_GIT_COMMIT", "APP_BASE_URL",
                       "PUBLIC_SUPABASE_URL", "GATEWAY_CONFIG", "APP_ENV"}
KEY_LIFETIME_SECONDS = 2 * 365 * 24 * 3600


def read_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value
    return env


def write_private(path: pathlib.Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp-" + secrets.token_hex(4))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def write_env(env: dict[str, str]) -> None:
    for key, value in env.items():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or "\n" in value:
            raise SystemExit("invalid stack.env entry: " + key)
    write_private(ENV_PATH, "".join(f"{k}={v}\n" for k, v in env.items()))


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def jwt(secret: str, role: str, now: int) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"role": role, "iss": "biomie-v2", "iat": now,
                                 "exp": now + KEY_LIFETIME_SECONDS}, separators=(",", ":")).encode())
    signing_input = f"{header}.{payload}"
    signature = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{b64url(signature)}"


def fingerprint(value: str) -> str:
    """Short non-reversible identifier so operators can tell keys apart."""
    return hashlib.sha256(value.encode()).hexdigest()[:10]


def render_gateway() -> None:
    env = read_env()
    for name in ("ANON_KEY", "SERVICE_ROLE_KEY"):
        if not env.get(name) or '"' in env[name] or "\\" in env[name]:
            raise SystemExit(f"{name} missing or not renderable")
    text = TEMPLATE.read_text(encoding="utf-8")
    text = text.replace("__ANON_KEY__", env["ANON_KEY"]).replace("__SERVICE_KEY__", env["SERVICE_ROLE_KEY"])
    if "__ANON_KEY__" in text or "__SERVICE_KEY__" in text:
        raise SystemExit("template placeholders left unrendered")
    write_private(GATEWAY_PATH, text)
    print(json.dumps({"gateway": str(GATEWAY_PATH), "anon_fp": fingerprint(env["ANON_KEY"]),
                      "service_fp": fingerprint(env["SERVICE_ROLE_KEY"])}))


def rotate_jwt() -> None:
    env = read_env()
    old = {k: fingerprint(env.get(k, "")) for k in ("JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY")}
    now = int(time.time())
    secret = secrets.token_hex(48)
    env["JWT_SECRET"] = secret
    env["ANON_KEY"] = jwt(secret, "anon", now)
    env["SERVICE_ROLE_KEY"] = jwt(secret, "service_role", now)
    env["JWT_ROTATED_AT"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
    write_env(env)
    new = {k: fingerprint(env[k]) for k in ("JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY")}
    print(json.dumps({"rotated": True, "old_fp": old, "new_fp": new,
                      "note": "old keys and all existing sessions are now invalid"}))


def ensure_secret(name: str) -> None:
    if name not in SECRET_NAMES:
        raise SystemExit("unknown secret name")
    env = read_env()
    if env.get(name):
        print(json.dumps({"secret": name, "created": False, "fp": fingerprint(env[name])}))
        return
    env[name] = secrets.token_hex(32)
    write_env(env)
    print(json.dumps({"secret": name, "created": True, "fp": fingerprint(env[name])}))


def set_values(pairs: list[str]) -> None:
    env = read_env()
    changed = {}
    for pair in pairs:
        key, _, value = pair.partition("=")
        if key not in NON_SECRET_SETTABLE:
            raise SystemExit("not settable: " + key)
        env[key] = value
        changed[key] = value
    write_env(env)
    print(json.dumps({"set": changed}))


def check() -> None:
    env = read_env()
    required = ["POSTGRES_PASSWORD", "AUTH_DB_PASSWORD", "REST_DB_PASSWORD", "JWT_SECRET", "ANON_KEY",
                "SERVICE_ROLE_KEY", "BIOMIE_JOB_TOKEN", "APP_BASE_URL", "PUBLIC_SUPABASE_URL",
                "RELEASE_ID", "SOURCE_DIR", "GATEWAY_CONFIG"]
    missing = [k for k in required if not env.get(k)]
    mode = oct(ENV_PATH.stat().st_mode & 0o777)
    print(json.dumps({"missing": missing, "mode": mode,
                      "has_credentials_key": bool(env.get("BIOMIE_CREDENTIALS_KEY")),
                      "release": env.get("RELEASE_ID"), "commit": env.get("BIOMIE_GIT_COMMIT")}))
    if missing or mode != "0o600":
        raise SystemExit(1)


def main(argv: list[str]) -> None:
    if not argv:
        raise SystemExit(__doc__)
    command, args = argv[0], argv[1:]
    if command == "render-gateway":
        render_gateway()
    elif command == "rotate-jwt":
        rotate_jwt()
    elif command == "ensure-secret" and len(args) == 1:
        ensure_secret(args[0])
    elif command == "set" and args:
        set_values(args)
    elif command == "check":
        check()
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
