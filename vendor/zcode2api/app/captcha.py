"""验证码求解（无浏览器）。

通过 Node + jsdom 在模拟浏览器环境中运行阿里云无痕 SDK，
求得 verifyParam（X-Aliyun-Captcha-Verify-Param）。不再启动真实浏览器。

- 缓存：求得的 verifyParam 在 TTL 内复用
- 并发：同一时刻只跑一个求解进程，其余请求等待后命中缓存
- 重试：单次求解偶发失败时自动重试
"""

from __future__ import annotations

import asyncio
import time
from urllib.parse import urlencode

import httpx

from . import logs, settings


class CaptchaManager:
    def __init__(self) -> None:
        self._cached: str | None = None
        self._cached_at: float = 0.0
        self._lock = asyncio.Lock()
        self._config_cache: dict | None = None
        self._config_cache_at: float = 0.0

    # ── 配置 ─────────────────────────────────────────────────────────────────
    async def fetch_config(self) -> dict:
        now = time.time() * 1000
        if self._config_cache and now - self._config_cache_at < settings.CAPTCHA_CONFIG_CACHE_TTL:
            return self._config_cache
        try:
            query = {"app_version": settings.CLIENT_VERSION}
            if settings.CLIENT_PLATFORM:
                query["platform"] = settings.CLIENT_PLATFORM
            async with httpx.AsyncClient(timeout=15) as client:
                res = await client.get(
                    "https://zcode.z.ai/api/v1/client/configs?" + urlencode(query)
                )
            res.raise_for_status()
            captcha = ((res.json().get("data") or {}).get("configs") or {}).get("captcha")
            if captcha:
                self._config_cache = captcha
                self._config_cache_at = now
                return captcha
        except (httpx.HTTPError, ValueError) as err:
            logs.warn("captcha", f"获取配置失败，使用默认: {err}")
        return dict(settings.CAPTCHA_FALLBACK)

    # ── 求解 ─────────────────────────────────────────────────────────────────
    async def get_verify_param(self, port: int | None = None) -> str:
        now = time.time() * 1000
        if self._cached and now - self._cached_at < settings.CAPTCHA_CACHE_TTL:
            return self._cached

        async with self._lock:
            # 二次检查：等锁期间可能已被其他请求填充
            if self._cached and time.time() * 1000 - self._cached_at < settings.CAPTCHA_CACHE_TTL:
                return self._cached

            config = await self.fetch_config()
            param = await self._solve(config)
            self._cached = param
            self._cached_at = time.time() * 1000
            return param

    async def _solve(self, config: dict) -> str:
        scene = config.get("sceneId") or "11xygtvd"
        region = config.get("region") or "sgp"
        prefix = config.get("prefix") or "no8xfe"

        last_err: str | None = None
        for attempt in range(1, settings.CAPTCHA_SOLVE_RETRIES + 1):
            try:
                param = await self._run_solver(scene, region, prefix)
            except Exception as err:  # noqa: BLE001
                last_err = str(err)
                param = None
            if param:
                if attempt > 1:
                    logs.ok("captcha", f"求解成功（第 {attempt} 次尝试）")
                return param
            logs.warn("captcha", f"第 {attempt}/{settings.CAPTCHA_SOLVE_RETRIES} 次求解未果，重试…")

        raise RuntimeError(f"验证码求解失败: {last_err or '多次重试无结果'}")

    async def _run_solver(self, scene: str, region: str, prefix: str) -> str | None:
        """按 CAPTCHA_SOLVER_MODE 选择求解器；auto 时浏览器优先、jsdom 兜底。"""
        mode = settings.CAPTCHA_SOLVER_MODE
        order = []
        if mode in ("auto", "browser"):
            order.append(("browser", settings.CAPTCHA_BROWSER_JS))
        if mode in ("auto", "jsdom", "node"):
            order.append(("jsdom", settings.CAPTCHA_SOLVER_JS))

        missing = []
        for name, script in order:
            if not script.exists():
                missing.append(f"{name}({script.name} 不存在)")
                continue
            try:
                param = await self._run_solver_script(script, scene, region, prefix)
            except Exception as err:  # noqa: BLE001
                logs.warn("captcha", f"{name} 求解异常: {err}")
                param = None
            if param:
                if name == "browser":
                    logs.ok("captcha", "浏览器版求解成功")
                return param
        if missing and not order:
            raise RuntimeError("没有可用的求解器：" + "，".join(missing) + "；先在 captcha_node 下执行 npm install")
        return None

    async def _run_solver_script(self, script, scene: str, region: str, prefix: str) -> str | None:
        if not settings.CAPTCHA_SOLVER_JS.exists() and script is settings.CAPTCHA_SOLVER_JS:
            raise RuntimeError(
                f"未找到求解器 {settings.CAPTCHA_SOLVER_JS}，请先在 captcha_node 下执行 npm install"
            )
        env = None
        if settings.CAPTCHA_BROWSER_PATH and script is settings.CAPTCHA_BROWSER_JS:
            import os as _os
            env = {**_os.environ, "ZCODE_BROWSER_PATH": settings.CAPTCHA_BROWSER_PATH}
        proc = await asyncio.create_subprocess_exec(
            settings.NODE_PATH, str(script), scene, region, prefix,
            cwd=str(settings.CAPTCHA_SOLVER_DIR),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **({} if env is None else {"env": env}),
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=settings.CAPTCHA_SOLVE_TIMEOUT)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            return None
        except FileNotFoundError as err:
            raise RuntimeError(f"无法启动 Node（{settings.NODE_PATH}）: {err}") from err

        for line in stdout.decode("utf-8", "ignore").splitlines():
            if line.startswith("VERIFY_PARAM="):
                return line[len("VERIFY_PARAM="):].strip()
        detail = stderr.decode("utf-8", "ignore").strip().splitlines()
        if detail:
            logs.warn("captcha", f"{script.name} 无输出（退出码 {proc.returncode}）：{detail[-1][:200]}")
        return None

    def invalidate(self) -> None:
        self._cached = None
        self._cached_at = 0.0

    async def close(self) -> None:
        pass


captcha_manager = CaptchaManager()
