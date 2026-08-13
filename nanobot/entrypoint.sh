#!/bin/sh
set -eu

mkdir -p /nanobot/workspace/skills /nanobot/workspace/.upstream /nanobot/workspace/nanobot-bin

if [ ! -f /nanobot/config.json ]; then
  cp /opt/knowledge-relay/config.docker.json /nanobot/config.json
fi
if [ ! -f /nanobot/workspace/AGENTS.md ]; then
  cp /opt/knowledge-relay/AGENTS.md /nanobot/workspace/AGENTS.md
fi
cp /opt/knowledge-relay/run-wechat-extractor.cjs /nanobot/workspace/nanobot-bin/run-wechat-extractor.cjs
cp /opt/knowledge-relay/extract-wechat-isolated.cjs /nanobot/workspace/nanobot-bin/extract-wechat-isolated.cjs

for skill in wechat-article-extractor fetch-skill; do
  if [ ! -d "/nanobot/workspace/skills/$skill" ]; then
    cp -R "/opt/knowledge-relay/skills/$skill" "/nanobot/workspace/skills/$skill"
  fi
  mkdir -p "/nanobot/workspace/.upstream/$skill"
  if [ ! -f "/nanobot/workspace/.upstream/$skill/SKILL.md" ]; then
    cp "/opt/knowledge-relay/skills/$skill/SKILL.md" "/nanobot/workspace/.upstream/$skill/SKILL.md"
  fi
done

exec nanobot serve \
  --config /nanobot/config.json \
  --workspace /nanobot/workspace \
  --host 0.0.0.0 \
  --port 8900 \
  --timeout 120
