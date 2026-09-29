"""在 ZCode 客户端的本地数据里找出所有 JWT，并用它们分别打 api.z.ai（x-api-key，免验证码）
与 plan 端点（Bearer，需验证码），看是否存在一份「新鲜且可用」的 token。

只打印长度与 sha256 前缀，不打印 token 全文。
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from pathlib import Path

import httpx

HOME = Path.home()
DATA_DB = HOME / ".dsh" / "zcode2api" / "data" / "accounts.db"
CLIENT_CFG = HOME / ".zcode" / "v2" / "config.json"
SEARCH_ROOTS = [
    HOME / "AppData" / "Roaming" / "ZCode",
    HOME / ".zcode",
]
JWT_RE = re.compile(rb"eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}")

FULL_HEADERS = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ZCode/3.14.3 Chrome/146.0.7680.80 Electron/41.0.3 Safari/537.36",
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": "Z Code@electron",
    "X-Platform": "win32-x64",
    "X-ZCode-App-Version": "3.14.3",
    "X-Release-Channel": "production",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": "Asia/Shanghai",
    "X-Os-Category": "windows",
}


def fp(token: str) -> str:
    return f"len={len(token)} sha={hashlib.sha256(token.encode()).hexdigest()[:8]}"


def known_tokens() -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        con = sqlite3.connect(str(DATA_DB))
        for (row,) in con.execute("SELECT data FROM accounts WHERE mode='jwt' AND data IS NOT NULL"):
            blob = json.loads(row)
            if blob.get("jwt_token"):
                out["账号池"] = blob["jwt_token"]
        con.close()
    except Exception:  # noqa: BLE001
        pass
    try:
        cfg = json.loads(CLIENT_CFG.read_text(encoding="utf-8"))
        tok = (cfg.get("provider", {}).get("builtin:zai-start-plan", {}).get("options", {}) or {}).get("apiKey", "")
        if tok:
            out["客户端config"] = tok
    except Exception:  # noqa: BLE001
        pass
    return out


def scan_disk() -> dict[str, str]:
    found: dict[str, str] = {}
    for root in SEARCH_ROOTS:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            try:
                if not path.is_file() or path.stat().st_size > 40 * 1024 * 1024:
                    continue
                data = path.read_bytes()
            except Exception:  # noqa: BLE001
                continue
            for match in JWT_RE.findall(data):
                token = match.decode("ascii", "ignore")
                found.setdefault(token, str(path))
    return found


def probe(token: str) -> None:
    body = {
        "model": "GLM-5.3-Flash",
        "max_tokens": 16,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "stream": False,
    }
    tests = [
        ("api.z.ai  x-api-key", "https://api.z.ai/api/anthropic/v1/messages", {"x-api-key": token}),
        ("plan      Bearer  ", "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", {"Authorization": f"Bearer {token}"}),
    ]
    for label, url, auth in tests:
        try:
            res = httpx.post(url, headers={**FULL_HEADERS, **auth}, json=body, timeout=60)
            text = res.text[:160].replace("\n", " ")
            flag = "   <<< 成功！" if res.status_code == 200 else ""
            print(f"    {label} -> HTTP {res.status_code}  {text}{flag}")
        except Exception as err:  # noqa: BLE001
            print(f"    {label} -> 异常 {type(err).__name__}: {err}")


def main() -> None:
    known = known_tokens()
    print("=== 已知 token ===")
    for name, tok in known.items():
        print(f"  {name}: {fp(tok)}")

    print("\n=== 磁盘扫出的 JWT ===")
    disk = scan_disk()
    print(f"  共 {len(disk)} 个不同的 JWT")
    for token, where in disk.items():
        tag = " [已知]" if token in known.values() else " [新!]"
        print(f"  {fp(token)}  来源 {Path(where).name}{tag}")

    print("\n=== 逐个探测 ===")
    seen = set()
    for token, where in disk.items():
        if token in seen:
            continue
        seen.add(token)
        print(f"  --- {fp(token)} ({Path(where).name}) ---")
        probe(token)


if __name__ == "__main__":
    main()
