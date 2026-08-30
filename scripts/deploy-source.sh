#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

for command_name in git node npm python3 make c++; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少运行依赖：$command_name" >&2
    exit 1
  fi
done

node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<13)){console.error('需要 Node.js 22.13 或更高版本');process.exit(1)}"
git submodule update --init --recursive

if [ ! -d .nanobot-venv ]; then
  python3 -m venv .nanobot-venv
fi
.nanobot-venv/bin/python -m pip install --upgrade pip
.nanobot-venv/bin/python -m pip install 'nanobot-ai[api,documents]==0.3.0'

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
fi

npm ci
npm run build:sqlite-native
npm run setup:nanobot
npm run build

echo "知流即将启动：http://127.0.0.1:8787"
echo "按 Ctrl+C 可安全停止服务。"
exec npm start
