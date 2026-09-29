# zcode2api — Python(FastAPI) + Node(jsdom 无痕验证求解器)
# 运行期同时需要 Python 与 Node：网关用 Python，验证码求解以 Node 子进程方式运行。
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ZCODE_HOST=0.0.0.0 \
    ZCODE_PORT=3000 \
    ZCODE_DATA_DIR=/data \
    ZCODE_NODE_PATH=node

WORKDIR /app

# ── Node.js（供无浏览器无痕验证求解器使用）──────────────────────────────────
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# ── Python 依赖（独立分层，便于缓存）────────────────────────────────────────
COPY requirements.txt ./
RUN pip install -r requirements.txt

# ── 求解器 Node 依赖（独立分层）─────────────────────────────────────────────
COPY captcha_node/package.json captcha_node/package-lock.json ./captcha_node/
RUN cd captcha_node && npm ci --omit=dev

# ── 应用源码 ────────────────────────────────────────────────────────────────
COPY . .

# 账号 / 设置持久化目录（建议挂载到宿主机卷）
VOLUME ["/data"]
EXPOSE 3000

CMD ["python", "main.py", "serve"]
