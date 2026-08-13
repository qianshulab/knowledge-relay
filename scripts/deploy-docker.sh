#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 Docker。请先安装 Docker Desktop 或 Docker Engine。" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "当前 Docker 未安装 Compose v2。" >&2
  exit 1
fi

git submodule update --init --recursive
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
fi

current_runtime_key=$(sed -n 's/^NANOBOT_RUNTIME_API_KEY=//p' .env | tail -n 1)
if [ -z "$current_runtime_key" ] || [ "$current_runtime_key" = "请替换为随机长字符串" ]; then
  if command -v openssl >/dev/null 2>&1; then
    runtime_key=$(openssl rand -hex 32)
  else
    echo "未找到 openssl，无法安全生成 Nanobot 内部鉴权密钥。" >&2
    exit 1
  fi
  sed -i.bak "s/^NANOBOT_RUNTIME_API_KEY=.*/NANOBOT_RUNTIME_API_KEY=$runtime_key/" .env
fi

docker compose up -d --build
docker compose ps
echo "知流已启动：http://127.0.0.1:8787"
echo "模型服务可在登录后的 系统设置 → AI 智能整理 中配置。"
