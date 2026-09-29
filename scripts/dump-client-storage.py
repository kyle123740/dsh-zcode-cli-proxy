"""把 ZCode 客户端 Local Storage（LevelDB）里的键值对捞出来看结构（敏感值只给指纹）。"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

LS_DIR = Path.home() / "AppData" / "Roaming" / "ZCode" / "session" / "Local Storage" / "leveldb"
INTERESTING = re.compile(rb"[ -~]{4,}")


def redact(value: str) -> str:
    v = value.strip()
    if len(v) >= 60 and re.fullmatch(r"[A-Za-z0-9_\-\.=+/]+", v):
        return f"<len={len(v)} sha={hashlib.sha256(v.encode()).hexdigest()[:8]}>"
    if len(v) > 120:
        return f"<len={len(v)} 文本>"
    return v


def main() -> None:
    if not LS_DIR.exists():
        print("找不到 Local Storage 目录:", LS_DIR)
        return
    for path in sorted(LS_DIR.glob("*")):
        if not path.is_file():
            continue
        data = path.read_bytes()
        if len(data) < 64:
            continue
        print(f"\n===== {path.name} ({len(data):,} 字节) =====")
        strings = [s.decode("utf-8", "ignore") for s in INTERESTING.findall(data)]
        # 找可能的存储键：通常形如 _https://zcode.z.ai\x00\x01key 或纯 key
        keys = set()
        for s in strings:
            for key in re.findall(r"[A-Za-z_][A-Za-z0-9_\.\-]{3,48}", s):
                if re.search(r"token|captcha|verify|device|credential|oauth|jwt|key|user|plan", key, re.I):
                    keys.add(key)
        print("  候选键:", ", ".join(sorted(keys))[:1200])
        # 打印含有关键字的完整字符串（值做脱敏）
        for s in strings:
            if re.search(r"captcha|verify|device|credential|oauth|jwt", s, re.I) and len(s) < 400:
                print("  *", redact(s))


if __name__ == "__main__":
    main()
