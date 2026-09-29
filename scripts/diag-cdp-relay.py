"""结论性测试：先在客户端里解验证码，再从客户端页面内发上游请求。"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from pathlib import Path

DATA_DB = Path.home() / ".dsh" / "zcode2api" / "data" / "accounts.db"
SOLVER_DIR = Path(__file__).resolve().parents[1] / "vendor" / "zcode2api" / "captcha_node"


def read_jwt() -> str:
    con = sqlite3.connect(str(DATA_DB))
    try:
        for (row,) in con.execute("SELECT data FROM accounts WHERE mode = 'jwt' AND data IS NOT NULL"):
            blob = json.loads(row)
            if blob.get("jwt_token"):
                return blob["jwt_token"]
    finally:
        con.close()
    raise SystemExit("没有 JWT 账号")


def main() -> None:
    jwt = read_jwt()
    proc = subprocess.run(
        ["node", str(SOLVER_DIR / "solver-client-cdp.js"), "11xygtvd", "cn", "no8xfe"],
        cwd=str(SOLVER_DIR), capture_output=True, text=True, timeout=180,
    )
    param = ""
    for line in proc.stdout.splitlines():
        if line.startswith("VERIFY_PARAM="):
            param = line.split("=", 1)[1].strip()
    print(f"verifyParam: {'已取得' if param else '求解失败'} ({proc.returncode})")
    if not param:
        print(proc.stderr[-300:])
        raise SystemExit(1)

    env = {**os.environ, "ZCODE2API_JWT": jwt, "ZCODE2API_PARAM": param}
    out = subprocess.run(
        ["node", str(SOLVER_DIR / "cdp-upstream-call.js")],
        cwd=str(SOLVER_DIR), capture_output=True, text=True, timeout=180, env=env,
    )
    print(out.stdout.strip() or out.stderr.strip()[-400:])


if __name__ == "__main__":
    main()
