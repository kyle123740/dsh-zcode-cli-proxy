"""用「客户端会话版求解器」拿到的 verifyParam 打上游，验证 3007 是否消失。

用法：venv\\Scripts\\python.exe scripts\\diag-upstream-cdp.py
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


def solve(script: str) -> str:
    proc = subprocess.run(
        ["node", str(SOLVER_DIR / script), "11xygtvd", "cn", "no8xfe"],
        cwd=str(SOLVER_DIR), capture_output=True, text=True, timeout=180,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("VERIFY_PARAM="):
            return line.split("=", 1)[1].strip()
    print(f"{script} 求解失败(exit {proc.returncode}): {proc.stderr[-300:]}")
    return ""


def main() -> None:
    jwt = read_jwt()
    body = {
        "model": "GLM-5.3-Flash",
        "max_tokens": 24,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "stream": False,
    }
    for script in ("solver-client-cdp.js", "solver-browser.js"):
        param = solve(script)
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
        try:
            res = httpx.post(UPSTREAM, headers=headers, json=body, timeout=120)
            text = res.text[:500].replace("\n", " ")
            print(f"{script:24s} -> HTTP {res.status_code}  {text}")
            if res.status_code == 200:
                print(">>> 成功！验证码已被服务端接受")
                return
        except Exception as err:  # noqa: BLE001
            print(f"{script:24s} -> 异常 {type(err).__name__}: {err}")


if __name__ == "__main__":
    main()
