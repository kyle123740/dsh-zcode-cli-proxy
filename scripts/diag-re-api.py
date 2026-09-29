"""按 zcodeReverseEngineering 的协议，用 JWT 直连 api.z.ai（无验证码路径）。

用法：venv\\Scripts\\python.exe scripts\\diag-re-api.py
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import httpx

DATA_DB = Path.home() / ".dsh" / "zcode2api" / "data" / "accounts.db"
ENDPOINTS = [
    "https://api.z.ai/api/anthropic/v1/messages",
    "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
]
MODELS = ["GLM-5.3-Flash", "glm-5.3-flash", "GLM-5-Turbo", "glm-4.6", "claude-sonnet-4-6"]


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

    # 逆向项目给出的客户端头
    base_headers = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "User-Agent": "ZCode/unknown",
        "HTTP-Referer": "https://zcode.z.ai",
        "X-Title": "Z Code@electron",
    }
    auth_variants = [
        ("x-api-key(JWT)", {"x-api-key": jwt}),
        ("Bearer(JWT)", {"Authorization": f"Bearer {jwt}"}),
    ]

    for url in ENDPOINTS:
        print(f"\n=== {url} ===")
        for auth_label, auth in auth_variants:
            for model in MODELS:
                body = {
                    "model": model,
                    "max_tokens": 16,
                    "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
                    "stream": False,
                }
                try:
                    res = httpx.post(url, headers={**base_headers, **auth}, json=body, timeout=60)
                    text = res.text[:200].replace("\n", " ")
                    flag = "  <<< OK" if res.status_code == 200 else ""
                    print(f"  {auth_label:16s} {model:20s} -> HTTP {res.status_code}  {text}{flag}")
                    if res.status_code == 200:
                        return
                except Exception as err:  # noqa: BLE001
                    print(f"  {auth_label:16s} {model:20s} -> 异常 {type(err).__name__}: {err}")


if __name__ == "__main__":
    main()
