#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

backup_argument=${1:-}
confirmation=${2:-}
if [ -z "$backup_argument" ] || [ "$confirmation" != "--confirm" ]; then
  echo "用法：./scripts/restore-docker.sh <备份目录> --confirm" >&2
  echo "恢复会替换当前应用数据、Nanobot 数据和 .env；脚本会先自动备份当前状态。" >&2
  exit 1
fi

case "$backup_argument" in
  /*) backup_path=$backup_argument ;;
  *) backup_path="$project_dir/$backup_argument" ;;
esac
if [ ! -d "$backup_path" ]; then
  echo "备份目录不存在：$backup_path" >&2
  exit 1
fi
backup_path=$(CDPATH= cd -- "$backup_path" && pwd)
case "$backup_path" in
  "$project_dir/data"|"$project_dir/data/"*)
    echo "备份目录不能位于当前 data/ 内部。" >&2
    exit 1
    ;;
esac

for required in data.tar.gz nanobot.tar.gz environment.env manifest.txt; do
  if [ ! -f "$backup_path/$required" ]; then
    echo "备份不完整，缺少 $required。" >&2
    exit 1
  fi
done
if [ -f "$backup_path/INCOMPLETE" ]; then
  echo "该目录被标记为未完成备份，拒绝恢复。" >&2
  exit 1
fi

if [ -f "$backup_path/SHA256SUMS" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$backup_path" && sha256sum -c SHA256SUMS)
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$backup_path" && shasum -a 256 -c SHA256SUMS)
  else
    echo "缺少 sha256sum 或 shasum，无法验证备份完整性。" >&2
    exit 1
  fi
else
  echo "备份没有 SHA256SUMS，拒绝自动恢复。" >&2
  exit 1
fi

validate_archive() {
  archive=$1
  if tar -tzf "$archive" | awk '
    /^\// { bad=1 }
    /(^|\/)\.\.($|\/)/ { bad=1 }
    END { exit bad ? 1 : 0 }
  '; then
    return 0
  fi
  echo "备份包含不安全路径：$archive" >&2
  exit 1
}
validate_archive "$backup_path/data.tar.gz"
validate_archive "$backup_path/nanobot.tar.gz"

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
  echo "当前账号无法访问 Docker daemon。" >&2
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

echo "正在为恢复前的当前状态创建安全备份…"
"$project_dir/scripts/backup-docker.sh"

stamp=$(date -u '+%Y%m%dT%H%M%SZ')
staging_data="$project_dir/data.restore.$stamp"
previous_data="$project_dir/data.before-restore.$stamp"
previous_env="$project_dir/.env.before-restore.$stamp"
if [ -e "$staging_data" ] || [ -e "$previous_data" ] || [ -e "$previous_env" ]; then
  echo "恢复临时路径已存在，请稍后重试：$stamp" >&2
  exit 1
fi
mkdir -p "$staging_data"
tar -xzf "$backup_path/data.tar.gz" -C "$staging_data"

echo "正在停止服务并恢复备份…"
run_docker compose stop knowledge-relay nanobot >/dev/null
if [ -d "$project_dir/data" ]; then
  mv "$project_dir/data" "$previous_data"
fi
mv "$staging_data" "$project_dir/data"

run_docker compose run --rm --no-deps \
  -v "$backup_path:/restore:ro" \
  --entrypoint sh knowledge-relay -c '
    set -eu
    for item in /nanobot/* /nanobot/.[!.]* /nanobot/..?*; do
      [ -e "$item" ] || continue
      rm -rf -- "$item"
    done
    tar -xzf /restore/nanobot.tar.gz -C /nanobot
  ' >/dev/null

if [ -f .env ]; then
  cp .env "$previous_env"
  chmod 600 "$previous_env"
fi
cp "$backup_path/environment.env" .env
chmod 600 .env

run_docker compose config --quiet
run_docker compose pull
run_docker compose up -d --no-build --remove-orphans

attempt=0
while [ "$attempt" -lt 60 ]; do
  if run_docker compose exec -T knowledge-relay node -e \
    'fetch("http://127.0.0.1:8787/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1 \
    && run_docker compose exec -T nanobot python -c \
    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8900/health', timeout=3).read()" >/dev/null 2>&1; then
    echo "恢复完成：$backup_path"
    echo "恢复前的 data 保留在：$previous_data"
    [ -f "$previous_env" ] && echo "恢复前的 .env 保留在：$previous_env"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

echo "数据已恢复，但服务未在 120 秒内就绪。" >&2
echo "恢复前数据仍保留在：$previous_data" >&2
echo "请查看：docker compose logs --tail=200 knowledge-relay nanobot" >&2
exit 1
