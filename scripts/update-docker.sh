#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

requested_version=${1:-}
if [ -z "$requested_version" ]; then
  echo "用法：./scripts/update-docker.sh <版本号>" >&2
  echo "示例：./scripts/update-docker.sh 1.9.8" >&2
  exit 1
fi

image_tag=${requested_version#v}
if ! printf '%s\n' "$image_tag" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$'; then
  echo "无效版本号：$requested_version" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 Docker。" >&2
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
  echo "未找到 .env。请先运行 ./scripts/deploy-docker.sh 完成首次部署。" >&2
  exit 1
fi

if [ "${KNOWLEDGE_RELAY_SKIP_BACKUP:-0}" != "1" ]; then
  "$project_dir/scripts/backup-docker.sh"
fi

backup_stamp=$(date -u '+%Y%m%dT%H%M%SZ')
env_backup=".env.backup.$backup_stamp"
cp .env "$env_backup"
chmod 600 "$env_backup"

env_temp_file=".env.update.$$"
trap 'rm -f "$env_temp_file"' EXIT HUP INT TERM
awk -v image_tag="$image_tag" '
  BEGIN { updated = 0 }
  /^KNOWLEDGE_RELAY_IMAGE_TAG=/ {
    if (!updated) {
      print "KNOWLEDGE_RELAY_IMAGE_TAG=" image_tag
      updated = 1
    }
    next
  }
  { print }
  END {
    if (!updated) {
      print ""
      print "KNOWLEDGE_RELAY_IMAGE_TAG=" image_tag
    }
  }
' .env > "$env_temp_file"
chmod 600 "$env_temp_file"
mv "$env_temp_file" .env

echo "正在更新知流到 $image_tag（配置备份：$env_backup）…"
run_docker compose config --quiet
run_docker compose pull
run_docker compose up -d --no-build --remove-orphans

attempt=0
while [ "$attempt" -lt 60 ]; do
  if run_docker compose exec -T knowledge-relay node -e \
    'fetch("http://127.0.0.1:8787/health").then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));' >/dev/null 2>&1 \
    && run_docker compose exec -T nanobot python -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8900/health', timeout=3).read()" >/dev/null 2>&1; then
    echo "知流 $image_tag 更新完成，主服务与 Nanobot Runtime 均已就绪。"
    run_docker compose ps
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

echo "更新后的服务未在 120 秒内就绪。请检查日志：" >&2
echo "  docker compose logs --tail=200 knowledge-relay nanobot" >&2
echo "原 .env 已保存在 $env_backup。" >&2
run_docker compose ps >&2
exit 1
