"""驱动 browser-e2e-test.js：把两份 JWT 通过环境变量传给 Node。"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from pathlib import Path

DATA_DB = Path.home() / ".dsh" / "zcode2api" / "data" / "accounts.db"
CLIENT_CFG = Path.home() / ".zcode" / "v2" / "config.json"
SOLVER_DIR = Path(__file__).resolve().parents[1] / "vendor" / "zcode2api" / "captcha_node"


def pool_jwt() -> str:
    con = sqlite3.connect(str(DATA_DB))
    try:
        for (row,) in con.execute("SELECT data FROM accounts WHERE mode = 'jwt' AND data IS NOT NULL"):
            blob = json.loads(row)
            if blob.get("jwt_token"):
                return blob["jwt_token"]
    finally:
        con.close()
    return ""


def client_jwt() -> str:
    try:
        cfg = json.loads(CLIENT_CFG.read_text(encoding="utf-8"))
        return (cfg.get("provider", {}).get("builtin:zai-start-plan", {}).get("options", {}) or {}).get("apiKey", "")
    except Exception:  # noqa: BLE001
        return ""


def main() -> None:
    env = {**os.environ, "ZCODE2API_JWT": pool_jwt(), "ZCODE2API_JWT2": client_jwt()}
    out = subprocess.run(
        ["node", str(SOLVER_DIR / "browser-e2e-test.js")],
        cwd=str(SOLVER_DIR), capture_output=True, text=True, timeout=300, env=env,
    )
    print(out.stdout.strip())
    if out.returncode != 0:
        print(out.stderr.strip()[-500:])


if __name__ == "__main__":
    main()
