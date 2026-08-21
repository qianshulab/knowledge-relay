#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

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
if [ ! -f .env ]; then
  echo "未找到 .env，当前目录不是完整的知流 Docker 部署目录。" >&2
  exit 1
fi

configured_backup_root=$(sed -n 's/^KNOWLEDGE_RELAY_BACKUP_DIR=//p' .env | tail -n 1)
backup_root=${KNOWLEDGE_RELAY_BACKUP_DIR:-${configured_backup_root:-"$project_dir/backups"}}
case "$backup_root" in
  /*) ;;
  *) backup_root="$project_dir/$backup_root" ;;
esac
mkdir -p "$backup_root"
backup_root=$(CDPATH= cd -- "$backup_root" && pwd)
case "$backup_root" in
  /|"$project_dir/data"|"$project_dir/data/"*)
    echo "备份目录不能是根目录或 data/ 内部目录。" >&2
    exit 1
    ;;
esac
chmod 700 "$backup_root"

stamp=$(date -u '+%Y%m%dT%H%M%SZ')
backup_name="knowledge-relay-$stamp"
backup_path="$backup_root/$backup_name"
mkdir -p "$backup_path"
chmod 700 "$backup_path"

running_services=$(run_docker compose ps --status running --services 2>/dev/null || true)
app_was_running=0
nanobot_was_running=0
printf '%s\n' "$running_services" | grep -qx 'knowledge-relay' && app_was_running=1 || true
printf '%s\n' "$running_services" | grep -qx 'nanobot' && nanobot_was_running=1 || true
backup_complete=0

restart_previous_services() {
  if [ "$app_was_running" = "1" ]; then
    run_docker compose up -d nanobot knowledge-relay >/dev/null
  elif [ "$nanobot_was_running" = "1" ]; then
    run_docker compose up -d nanobot >/dev/null
  fi
}

on_exit() {
  restart_previous_services || true
  if [ "$backup_complete" != "1" ]; then
    printf '%s\n' "备份未完成，请勿用于恢复。" > "$backup_path/INCOMPLETE"
  fi
}
on_signal() {
  trap - EXIT HUP INT TERM
  on_exit
  exit 1
}
trap on_exit EXIT
trap on_signal HUP INT TERM

echo "正在暂停知流，创建一致性备份…"
run_docker compose stop knowledge-relay nanobot >/dev/null

host_uid=$(id -u)
host_gid=$(id -g)
run_docker compose run --rm --no-deps \
  -e BACKUP_NAME="$backup_name" \
  -e HOST_UID="$host_uid" \
  -e HOST_GID="$host_gid" \
  -v "$backup_root:/backup" \
  --entrypoint sh knowledge-relay -c '
    set -eu
    umask 077
    target="/backup/$BACKUP_NAME"
    tar -czf "$target/data.tar.gz" -C /app/data .
    tar -czf "$target/nanobot.tar.gz" -C /nanobot .
    chown "$HOST_UID:$HOST_GID" "$target/data.tar.gz" "$target/nanobot.tar.gz" 2>/dev/null || true
  ' >/dev/null

cp .env "$backup_path/environment.env"
cp compose.yaml "$backup_path/compose.yaml"
chmod 600 "$backup_path/environment.env" "$backup_path/compose.yaml"
{
  echo "created_at=$stamp"
  echo "application_image=$(sed -n 's/^KNOWLEDGE_RELAY_IMAGE_TAG=//p' .env | tail -n 1)"
  echo "contents=data.tar.gz,nanobot.tar.gz,environment.env,compose.yaml"
} > "$backup_path/manifest.txt"
chmod 600 "$backup_path/manifest.txt"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$backup_path" && sha256sum data.tar.gz nanobot.tar.gz environment.env compose.yaml manifest.txt > SHA256SUMS)
elif command -v shasum >/dev/null 2>&1; then
  (cd "$backup_path" && shasum -a 256 data.tar.gz nanobot.tar.gz environment.env compose.yaml manifest.txt > SHA256SUMS)
else
  echo "警告：主机没有 sha256sum 或 shasum，未生成校验文件。" >&2
fi

backup_complete=1
restart_previous_services
trap - EXIT HUP INT TERM

echo "备份完成：$backup_path"
echo "其中包含应用数据、附件、加密主密钥、Nanobot 配置、用户 Workspace 与部署配置。"
