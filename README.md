# 知流 · Knowledge Relay

一个可自行部署的个人微信 iLink 收件产品：系统接收你发送给机器人的文字和附件，交给官方 HKUDS/nanobot Runtime 调用模型、选择并执行原版 Skills，再把结构化笔记和 Markdown 附件可靠地增量同步到指定 Obsidian Vault 收件箱。

产品边界：微信消息是收件来源，Nanobot 是唯一 Agent Runtime，Obsidian 是知识落点。模型 Key、模型路由、Agent Loop、工具调用和原版 Skills 全部由 Nanobot 管理；知流不直连 DeepSeek。系统不把普通 Agent 对话混入收件箱。

## 已实现

- 首次个人账户初始化、密码登录和 HttpOnly 会话
- 支持连接自己的 iLink Bot；每个连接独立长轮询
- 接收文字、图片、语音、文件和视频，下载并解密微信 CDN 附件
- SQLite 消息库、唯一约束、附件校验和、历史 JSONL 自动迁移
- 微信 Bot 凭据使用 AES-256-GCM 加密；网页登录会话和插件令牌只存 SHA-256 哈希；模型 Key 只通过环境变量交给 Nanobot
- 官方 Nanobot Runtime 负责调用 DeepSeek、运行 Agent Loop、工具和 Skills，自动生成标题、分类、标签、摘要和待办
- 完整安装固定版本的 `wechat-article-extractor` 与 `fetch-skill`；后台展示的就是实际加载的原版 `SKILL.md`
- 后台可启停、修改、恢复原版 Skill；Nanobot 解析后的 Markdown 作为派生附件同步
- 模型不可用时自动使用内置规则，不阻塞收件与同步，并可通过当前微信消息做去重提醒
- 可视化控制台：消息、微信账号、Agent、Skills 和同步设备
- 控制台支持图片、PDF、文本、音视频安全预览，其他附件下载
- 页面每 5 秒检测新消息并自动刷新概览和收件箱
- Obsidian 稳定批次、独立设备游标、ACK 后逻辑归档、修订覆盖和附件下载
- 轻量 Obsidian 插件：启动/定时/手动同步、模板优先、Markdown 派生附件、SHA-256 校验和断点重试

## 本机启动

需要 Node.js 22.13 或更高版本、Python 3.11+，并安装带 API/文档插件的官方 `nanobot-ai==0.3.0`。

```bash
npm install
uv tool install 'nanobot-ai[api,documents]==0.3.0'
git submodule update --init --recursive
cp .env.example .env
# 在 .env 填写 DEEPSEEK_API_KEY
npm run dev
```

打开 <http://127.0.0.1:8787>。首次打开会引导创建个人账户，并自动导入旧版本的 `data/state.json`、`data/inbox/*.jsonl` 和已绑定微信账号。由旧多用户版本升级时，系统保留拥有实际数据的主账户，并删除无数据的附加账户和邀请码。

生产模式：

```bash
npm run build
npm start
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

## 第一次使用

1. 创建个人账户并登录。
2. 打开“微信连接”，点击“添加微信”，扫码并在手机确认。
3. 给机器人发送文字或附件，在“收件箱”查看整理后的笔记。
4. 打开“Obsidian 同步”，创建设备，复制只显示一次的 `obsidian_...` 令牌。
5. 直接在同步页面下载插件，或按 [插件安装说明](./obsidian-plugin/README.md) 安装，填写服务地址和令牌。以后插件单独升级时，可在同一页面展开“发布新版”并上传 ZIP，下载入口会自动切换到新版本。
6. 点击插件的“立即同步”。写入成功后，服务端消息会显示“已归档”。

插件默认优先使用当前 Vault 的 `90-系统/模板/T-快速捕获.md`。可在插件设置中关闭模板或更换路径；模板不可用时会自动回退，不会阻塞同步。

点击侧边栏个人账户旁的设置按钮可以修改登录密码；修改后所有旧网页登录会话都会自动失效。

控制台“Nanobot Skills”会显示实际 workspace 中加载的完整原版 Skills。编辑、停用或恢复会直接更新 Nanobot workspace；其他内置提示规则用于补充收件整理偏好。修改只影响之后收到的新消息。

## Nanobot

知流只调用 HKUDS/nanobot 的本机 API，不调用任何模型供应商 API。`npm run dev` 会初始化专用 workspace，并同时启动 Nanobot 与知流：

```bash
uv tool install 'nanobot-ai[api,documents]==0.3.0'
git submodule update --init --recursive
npm run setup:nanobot
npm run dev
```

Nanobot 默认监听 `127.0.0.1:8900`。打开“AI Agent”即可选择模型提供者、模型、API 地址并保存凭据。控制台只把配置写入 `data/nanobot/config.json`，不会把密钥写进知流数据库或回显到浏览器；实际模型请求仍完全由 Nanobot 发起。

也可以继续通过 `.env` 为默认 DeepSeek 提供凭据：

```text
DEEPSEEK_API_KEY=你的测试或生产 Key
NANOBOT_BASE_URL=http://127.0.0.1:8900/v1/
NANOBOT_CATALOG_URL=http://127.0.0.1:8901/
```

本机地址不要求 Runtime API Key；Docker 内部网络必须用独立的 `NANOBOT_RUNTIME_API_KEY` 鉴权。每条收件使用隔离的任务 session。本产品不开放通用 Agent 对话，也不会把对话混入收件箱。

出于安全边界，Nanobot Runtime 地址仍只能通过服务器的 `NANOBOT_BASE_URL` 配置。页面可以管理 Nanobot 内部的 OpenAI、DeepSeek、Anthropic、OpenRouter、Gemini、百炼、Kimi、智谱、硅基流动、本地 Ollama/vLLM 和自定义 OpenAI 兼容提供者。模型标识会通过 Nanobot 的内部目录服务实时读取；不支持目录的提供者仍可手动输入。保存后托管 Runtime 会自动重新加载。

本机部署还可以在页面发起 OpenAI Codex OAuth；它会打开 OpenAI 官方授权页面，令牌由 Nanobot 的 OAuth 存储管理。远程或 Docker 部署建议使用 OpenAI API Key，或在 Nanobot 容器终端完成 OAuth。

两个用户指定的上游仓库以 Git submodule 固定到明确 commit。初始化脚本会把完整文件安装到 `data/nanobot/workspace/skills/`，并安装微信公众号 Skill 的 Node.js 依赖：

```bash
git submodule update --init --recursive
npm run setup:nanobot
```

另外保留收件分类、Obsidian 笔记和文档整理规则。知流只向 Nanobot 提交任务契约和用户偏好；原版 Skill 的选择、读取和脚本执行均发生在 Nanobot Agent Loop 内。

## 网页 Skills 的执行语义

- 两个上游仓库固定到 [THIRD_PARTY.md](./THIRD_PARTY.md) 记录的 commit；原文件不被知流修改。
- 原版 `fetch-skill` 的默认回退链可能把 URL 发送给 Jina Reader、defuddle.md 或 markdown.new；这是原 Skill 的既有行为，使用前请理解隐私影响。
- 原版 `fetch-skill` 还包含 FxTwitter、Camofox、WeSpy 与可选 wechat exporter 能力；相关外部服务未安装时会按其原始回退逻辑运行。
- Skill 脚本只在独立 Nanobot Runtime 中执行。Nanobot 配置限制 workspace 文件访问；Docker 进一步把它与知流进程隔离。
- 网页内容仍视为不可信资料，知流只接收 Nanobot 返回的严格 JSON 与指定 artifacts 目录中的派生文件。
- 只有模型成功分类后才保存派生 Markdown；模型失败时只保留原消息。

## Obsidian 同步语义

- 管理员可在 Obsidian 模块上传并独立发布插件安装包；服务端会校验插件 ID、版本、必需文件、文件路径、压缩体积和 SHA-256，并拒绝降级或同版本替换。
- 上传的插件版本保存在 `DATA_DIR/plugin-release/`，Docker 重建或重启不会丢失；未上传时自动使用镜像随附的版本，公开下载地址始终保持不变。
- 原始消息不会因同步成功而删除。
- 每个 Vault/设备拥有独立游标。
- 插件会先写完一整个批次的笔记和附件，再发送 ACK。
- 未 ACK 的批次会稳定重放；相同消息不会创建第二份笔记。
- AI 以后产生修订时，会生成新同步事件并覆盖该消息原有笔记。
- 控制台中的“已归档”表示主设备已经确认到达该消息对应的同步事件。

## 个人版与安全

- 系统只保留一个个人账户，不提供注册、邀请码或用户管理接口。
- 密码登录继续保护管理页面；Obsidian 使用可独立撤销的设备令牌。
- 插件令牌等同于一个 Vault 的读权限，可随时在控制台撤销。
- 默认只监听 `127.0.0.1`。公网部署必须配置 HTTPS 反向代理，并设置 `PUBLIC_BASE_URL=https://...`。
- 数据目录中的 `app-secret.key` 是解密凭据所需的主密钥；备份时必须和数据库一起安全备份，但不要公开或提交版本库。
- 当前使用 SQLite，适合个人单实例部署。

## Docker

编辑 `.env` 后运行：

```bash
docker compose up -d --build
```

Compose 会构建两个隔离服务：`knowledge-relay` 和官方 `nanobot-ai==0.3.0` sidecar。Nanobot 镜像同时准备 Python 3、Node.js 22、文档解析能力、原版 fetch 脚本和公众号 Skill 的固定 npm 依赖，并在构建时逐项检查。后台仍只发布到宿主机 `127.0.0.1:8787`，Nanobot 端口不对宿主机和公网暴露。

模型凭据既可以预先放在 `.env`，也可以启动后在后台写入共享 Nanobot 配置。后台不会返回已保存的密钥；公网配置模型前必须先启用 HTTPS。

容器使用非 root 用户、健康检查、`no-new-privileges` 和受限临时目录。公网部署请在 HTTPS 反向代理后使用，并填写 `PUBLIC_BASE_URL`。升级前将数据库、媒体、派生附件和 `app-secret.key` 一起备份。

## 验证

```bash
npm run typecheck
npm test
npm run build
node --check obsidian-plugin/main.js
npm run package:plugin
```

## 数据位置

- `data/inbox.sqlite`：个人账户、Bot、消息、同步批次和设置
- `data/app-secret.key`：本机主加密密钥
- `data/media/<date>/...`：按日期保存的附件
- `data/derived/<date>/...`：安全解析出的 Markdown 附件
- `data/nanobot/`：本机 Nanobot 配置、workspace、Skills、sessions 和 artifacts
- `data/state.json`、`data/inbox/*.jsonl`：旧版数据，仅用于首次迁移，不再作为主存储

## 当前产品边界

- iLink 协议按腾讯公开的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 实现；公开商业运营前应另外确认微信/iLink 的服务条款和限流规则。
- Agent Skills 应使用经过审查、固定版本的白名单，不要安装不可信的任意脚本。
- 复杂扫描 PDF、需要登录/验证码的网页和 SILK 语音转码属于后续可插拔处理器，消息接收和 Obsidian 同步本身不依赖这些能力。

安全、隐私和本轮十次迭代记录见 [SECURITY.md](./SECURITY.md)、[PRIVACY.md](./PRIVACY.md) 与 [docs/ITERATION-REPORT.md](./docs/ITERATION-REPORT.md)。
