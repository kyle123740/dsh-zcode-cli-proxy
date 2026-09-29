"""对比「账号池里的 JWT」与「ZCode 客户端当前的 JWT」，并用客户端那份重测两个端点。

用法：venv\\Scripts\\python.exe scripts\\diag-fresh-jwt.py
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import httpx

DATA_DB = Path.home() / ".dsh" / "zcode2api" / "data" / "accounts.db"
CLIENT_CFG = Path.home() / ".zcode" / "v2" / "config.json"


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
    cfg = json.loads(CLIENT_CFG.read_text(encoding="utf-8"))
    return (cfg.get("provider", {}).get("builtin:zai-start-plan", {}).get("options", {}) or {}).get("apiKey", "")


def fp(token: str) -> str:
    return f"len={len(token)} sha256[:8]={hashlib.sha256(token.encode()).hexdigest()[:8]}" if token else "(空)"


def main() -> None:
    pool = pool_jwt()
    fresh = client_jwt()
    print("账号池 JWT :", fp(pool))
    print("客户端 JWT :", fp(fresh))
    print("是否同一份 :", pool == fresh)

    headers_base = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "User-Agent": "ZCode/unknown",
        "HTTP-Referer": "https://zcode.z.ai",
        "X-Title": "Z Code@electron",
    }
    body = {
        "model": "GLM-5.3-Flash",
        "max_tokens": 16,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "stream": False,
    }

    for label, token in (("客户端JWT", fresh),):
        if not token:
            print("客户端没有 JWT")
            continue
        for url in (
            "https://api.z.ai/api/anthropic/v1/messages",
            "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
        ):
            for auth_label, auth in (("x-api-key", {"x-api-key": token}), ("Bearer", {"Authorization": f"Bearer {token}"})):
                try:
                    res = httpx.post(url, headers={**headers_base, **auth}, json=body, timeout=60)
                    text = res.text[:180].replace("\n", " ")
                    flag = "   <<< 成功！" if res.status_code == 200 else ""
                    print(f"  {url.split('/api/')[-1][:28]:30s} {auth_label:10s} -> HTTP {res.status_code}  {text}{flag}")
                except Exception as err:  # noqa: BLE001
                    print(f"  {url} {auth_label} -> 异常 {type(err).__name__}: {err}")


if __name__ == "__main__":
    main()
