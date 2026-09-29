"""诊断 3：用有界面（headful）浏览器求解后再打上游，验证 headless 是否被风控识别。

  $env:ZCODE_BROWSER_HEADFUL='1'   # 由调用方设置
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
from pathlib import Path

import httpx

DATA_DB = Path.home() / ".dsh" / "zcode2api" / "data" / "accounts.db"
SOLVER_DIR = Path(__file__).resolve().parents[1] / "vendor" / "zcode2api" / "captcha_node"
UPSTREAM = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"


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


def solve(region: str) -> str:
    proc = subprocess.run(
        ["node", str(SOLVER_DIR / "solver-browser.js"), "11xygtvd", region, "no8xfe"],
        cwd=str(SOLVER_DIR), capture_output=True, text=True, timeout=180,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("VERIFY_PARAM="):
            return line.split("=", 1)[1].strip()
    print("求解失败:", proc.stderr[-300:])
    return ""


def main() -> None:
    import os

    jwt = read_jwt()
    print("headful =", os.environ.get("ZCODE_BROWSER_HEADFUL") == "1")
    body = {
        "model": "GLM-5.3-Flash",
        "max_tokens": 24,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "stream": False,
    }
    for region in ("cn", "sgp"):
        param = solve(region)
        if not param:
            continue
        headers = {
            "content-type": "application/json",
            "Authorization": f"Bearer {jwt}",
            "anthropic-version": "2023-06-01",
            "User-Agent": "ZCode/3.14.3",
            "X-ZCode-App-Version": "3.14.3",
            "X-ZCode-Agent": "glm",
            "HTTP-Referer": "https://zcode.z.ai/",
            "X-Aliyun-Captcha-Verify-Param": param,
        }
        res = httpx.post(UPSTREAM, headers=headers, json=body, timeout=90)
        print(f"region={region:4s} headful -> HTTP {res.status_code}  {res.text[:300].replace(chr(10), ' ')}")


if __name__ == "__main__":
    main()
