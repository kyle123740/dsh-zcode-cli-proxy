"""诊断 4：用 JWT 直接查 zcode 计费/额度接口，判断 JWT 是否仍然有效（不走验证码）。

用法：venv\\Scripts\\python.exe scripts\\diag-jwt.py
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import httpx

DATA_DB = Path.home() / ".dsh" / "zcode2api" / "data" / "accounts.db"
CANDIDATES = [
    "https://zcode.z.ai/api/v1/zcode-plan/billing/balance",
    "https://zcode.z.ai/api/v1/zcode-plan/billing/subscription",
    "https://zcode.z.ai/api/v1/zcode-plan/user/info",
    "https://zcode.z.ai/api/v1/zcode-plan/quota",
]


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
    print(f"JWT 长度 {len(jwt)}")
    for url in CANDIDATES:
        for scheme in ("Bearer", "raw"):
            headers = {
                "User-Agent": "ZCode/3.14.3",
                "X-ZCode-App-Version": "3.14.3",
                "HTTP-Referer": "https://zcode.z.ai/",
            }
            if scheme == "Bearer":
                headers["Authorization"] = f"Bearer {jwt}"
            else:
                headers["X-ZCode-Token"] = jwt
            try:
                res = httpx.get(url, headers=headers, timeout=30)
                body = res.text[:260].replace("\n", " ")
                print(f"{scheme:6s} {url.split('/zcode-plan/')[1]:24s} -> HTTP {res.status_code}  {body}")
            except Exception as err:  # noqa: BLE001
                print(f"{scheme:6s} {url} -> 异常 {type(err).__name__}: {err}")


if __name__ == "__main__":
    main()
