#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 Docker。请先安装 Docker Desktop 或 Docker Engine。" >&2
  exit 1
fi

docker_needs_sudo=0
if docker info >/dev/null 2>&1; then
  docker_needs_sudo=0
elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
  docker_needs_sudo=1
else
  echo "当前账号无法访问 Docker daemon。请配置 Docker 权限或确认 sudo 可用。" >&2
  exit 1
fi

run_docker() {
  if [ "$docker_needs_sudo" = "1" ]; then
    sudo docker "$@"
  else
    docker "$@"
  fi
}

if ! run_docker compose version >/dev/null 2>&1; then
  echo "当前 Docker 未安装 Compose v2。" >&2
  exit 1
fi

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
  env_temp_file=".env.tmp.$$"
  trap 'rm -f "$env_temp_file"' EXIT HUP INT TERM
  awk -v runtime_key="$runtime_key" '
    /^NANOBOT_RUNTIME_API_KEY=/ { print "NANOBOT_RUNTIME_API_KEY=" runtime_key; next }
    { print }
  ' .env > "$env_temp_file"
  chmod 600 "$env_temp_file"
  mv "$env_temp_file" .env
fi

if [ "${KNOWLEDGE_RELAY_LOCAL_BUILD:-0}" = "1" ]; then
  git submodule update --init --recursive
  run_docker compose up -d --build
else
  run_docker compose pull
  run_docker compose up -d --no-build
fi
run_docker compose ps
configured_bind=$(sed -n 's/^KNOWLEDGE_RELAY_BIND_ADDRESS=//p' .env | tail -n 1)
configured_port=$(sed -n 's/^PORT=//p' .env | tail -n 1)
published_bind=${KNOWLEDGE_RELAY_BIND_ADDRESS:-${configured_bind:-0.0.0.0}}
published_port=${PORT:-${configured_port:-8787}}
if [ "$published_bind" = "0.0.0.0" ]; then
  echo "知流已启动：本机 http://127.0.0.1:$published_port，局域网 http://<主机IP>:$published_port"
else
  echo "知流已启动：http://$published_bind:$published_port"
fi
echo "模型服务可在登录后的 系统设置 → AI 智能整理 中配置。"
