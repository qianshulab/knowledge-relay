#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

if ! command -v docker >/dev/null 2>&1; then
  echo "[失败] 未找到 Docker。" >&2
  exit 1
fi

docker_needs_sudo=0
if docker info >/dev/null 2>&1; then
  docker_needs_sudo=0
elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
  docker_needs_sudo=1
else
  echo "[失败] 当前账号无法访问 Docker daemon。" >&2
  exit 1
fi

run_docker() {
  if [ "$docker_needs_sudo" = "1" ]; then
    sudo docker "$@"
  else
    docker "$@"
  fi
}

failed=0
check() {
  label=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "[正常] $label"
  else
    echo "[失败] $label" >&2
    failed=1
  fi
}

check "Compose 配置" run_docker compose config --quiet
check "知流容器正在运行" run_docker compose exec -T knowledge-relay true
check "Nanobot 容器正在运行" run_docker compose exec -T nanobot true
check "应用数据库与管理服务" run_docker compose exec -T knowledge-relay node -e \
  'fetch("http://127.0.0.1:8787/health",{signal:AbortSignal.timeout(5000)}).then(async r=>{const body=await r.json();if(!r.ok||!body.ok||!body.database)process.exit(1)}).catch(()=>process.exit(1))'
check "Nanobot 整理网关" run_docker compose exec -T nanobot python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8900/health', timeout=5).read()"
check "Nanobot 检索网关" run_docker compose exec -T nanobot python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8902/health', timeout=5).read()"
check "模型目录服务" run_docker compose exec -T nanobot python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8901/health', timeout=5).read()"
check "应用数据目录可写" run_docker compose exec -T knowledge-relay sh -c 'test -w /app/data'
check "Nanobot 数据目录可写" run_docker compose exec -T nanobot sh -c 'test -w /nanobot'

echo
echo "容器状态："
run_docker compose ps
echo
echo "持久化目录容量："
run_docker compose exec -T knowledge-relay df -h /app/data /nanobot 2>/dev/null || true

if [ "$failed" -ne 0 ]; then
  echo
  echo "诊断未通过。请查看：docker compose logs --since=10m --tail=200 knowledge-relay nanobot" >&2
  exit 1
fi

echo
echo "知流核心服务诊断通过。模型账号是否可用，请在系统设置中执行“检查基础连接”。"
