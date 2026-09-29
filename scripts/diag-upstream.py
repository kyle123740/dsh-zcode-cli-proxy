"""诊断：直连 zcode 计划端点，打印上游真实错误体，并对比不同版本头。

用法：venv\\Scripts\\python.exe scripts\\diag-upstream.py
凭证从网关数据库读取，不在输出中出现。
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import httpx

DATA_DB = Path.home() / ".dsh" / "zcode2api" / "data" / "accounts.db"
SOLVER_DIR = Path(__file__).resolve().parents[1] / "vendor" / "zcode2api" / "captcha_node"
SOLVER = SOLVER_DIR / "solver-browser.js"
UPSTREAM = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"


def read_jwt() -> str:
    con = sqlite3.connect(str(DATA_DB))
    try:
        for (row,) in con.execute(
            "SELECT data FROM accounts WHERE mode = 'jwt' AND data IS NOT NULL"
        ):
            try:
                blob = json.loads(row)
            except (TypeError, ValueError):
                continue
            token = blob.get("jwt_token")
            if token:
                return token
    finally:
        con.close()
    raise SystemExit("数据库里没有 JWT 账号")


def solve() -> str:
    proc = subprocess.run(
        ["node", str(SOLVER), "11xygtvd", "cn", "no8xfe"],
        cwd=str(SOLVER_DIR), capture_output=True, text=True, timeout=120,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("VERIFY_PARAM="):
            return line.split("=", 1)[1].strip()
    print("求解失败:", proc.stderr[-500:], file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    jwt = read_jwt()
    print(f"JWT: 长度 {len(jwt)}，前缀 {jwt[:6]}…（不回显）")
    param = solve()
    print(f"verifyParam: 长度 {len(param)}，前缀 {param[:24]}…")

    body = {
        "model": "GLM-5.3-Flash",
        "max_tokens": 24,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "stream": False,
    }

    variants = [
        ("陈旧版本头 3.0.1", {"User-Agent": "ZCode/3.0.1", "X-ZCode-App-Version": "3.0.1", "X-ZCode-Agent": "glm"}),
        ("真实版本头 3.14.3", {"User-Agent": "ZCode/3.14.3", "X-ZCode-App-Version": "3.14.3", "X-ZCode-Agent": "glm"}),
        ("真实版本头 3.14.3.7762", {"User-Agent": "ZCode/3.14.3.7762", "X-ZCode-App-Version": "3.14.3.7762", "X-ZCode-Agent": "glm"}),
    ]

    for label, extra in variants:
        headers = {
            "content-type": "application/json",
            "Authorization": f"Bearer {jwt}",
            "anthropic-version": "2023-06-01",
            "HTTP-Referer": "https://zcode.z.ai/",
            "X-Aliyun-Captcha-Verify-Param": param,
            **extra,
        }
        try:
            res = httpx.post(UPSTREAM, headers=headers, json=body, timeout=90)
            text = res.text[:400].replace("\n", " ")
            print(f"{label:26s} -> HTTP {res.status_code}  {text}")
        except Exception as err:  # noqa: BLE001
            print(f"{label:26s} -> 异常 {type(err).__name__}: {err}")


if __name__ == "__main__":
    main()
