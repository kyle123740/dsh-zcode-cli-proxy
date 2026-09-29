"""诊断 2：解码 verifyParam，并尝试 region / User-Agent 组合，定位 3007 的原因。

用法：venv\\Scripts\\python.exe scripts\\diag-upstream2.py
"""
from __future__ import annotations

import base64
import json
import sqlite3
import subprocess
from pathlib import Path

import httpx

DATA_DB = Path.home() / ".dsh" / "zcode2api" / "data" / "accounts.db"
SOLVER_DIR = Path(__file__).resolve().parents[1] / "vendor" / "zcode2api" / "captcha_node"
SOLVER = SOLVER_DIR / "solver-browser.js"
UPSTREAM = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages"
CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"


def read_jwt() -> str:
    con = sqlite3.connect(str(DATA_DB))
    try:
        for (row,) in con.execute("SELECT data FROM accounts WHERE mode = 'jwt' AND data IS NOT NULL"):
            blob = json.loads(row)
            if blob.get("jwt_token"):
                return blob["jwt_token"]
    finally:
        con.close()
    raise SystemExit("数据库里没有 JWT 账号")


def solve(region: str) -> str:
    proc = subprocess.run(
        ["node", str(SOLVER), "11xygtvd", region, "no8xfe"],
        cwd=str(SOLVER_DIR), capture_output=True, text=True, timeout=150,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("VERIFY_PARAM="):
            return line.split("=", 1)[1].strip()
    print(f"region={region} 求解失败: {proc.stderr[-300:]}")
    return ""


def decode(param: str) -> None:
    pad = "=" * (-len(param) % 4)
    try:
        raw = base64.urlsafe_b64decode(param + pad).decode("utf-8", "ignore")
        data = json.loads(raw)
        masked = {k: (f"<len={len(str(v))}>" if isinstance(v, str) and len(str(v)) > 24 else v) for k, v in data.items()}
        print("verifyParam 字段:", json.dumps(masked, ensure_ascii=False))
    except Exception as err:  # noqa: BLE001
        print("解码失败:", err)


def main() -> None:
    jwt = read_jwt()
    print(f"JWT 长度 {len(jwt)}")

    first = solve("cn")
    if first:
        decode(first)

    body = {
        "model": "GLM-5.3-Flash",
        "max_tokens": 24,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "stream": False,
    }

    cases = [("cn", "ZCode/3.14.3"), ("sgp", "ZCode/3.14.3"), ("cn", CHROME_UA)]
    for region, ua in cases:
        param = solve(region) if region != "cn" or ua != "ZCode/3.14.3" else first
        if not param:
            continue
        headers = {
            "content-type": "application/json",
            "Authorization": f"Bearer {jwt}",
            "anthropic-version": "2023-06-01",
            "User-Agent": ua,
            "X-ZCode-App-Version": "3.14.3",
            "X-ZCode-Agent": "glm",
            "HTTP-Referer": "https://zcode.z.ai/",
            "X-Aliyun-Captcha-Verify-Param": param,
        }
        try:
            res = httpx.post(UPSTREAM, headers=headers, json=body, timeout=90)
            print(f"region={region:4s} UA={ua[:22]:24s} -> HTTP {res.status_code}  {res.text[:200].replace(chr(10), ' ')}")
        except Exception as err:  # noqa: BLE001
            print(f"region={region:4s} UA={ua[:22]:24s} -> 异常 {type(err).__name__}: {err}")


if __name__ == "__main__":
    main()
