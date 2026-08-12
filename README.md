# 知流 · Knowledge Relay

一个可自行部署的个人微信 iLink 收件产品：系统接收你发送给机器人的文字和附件，用安全适配器解析公众号和公开网页，再由 Nanobot 或 OpenAI 兼容模型整理成 Obsidian Markdown，通过轻量插件可靠地增量同步到指定 Vault 收件箱。

产品边界：微信消息是收件来源，Nanobot 是可选处理引擎，Obsidian 是知识落点。系统不把普通 Agent 对话混入收件箱；当前后台也不开放通用聊天，只提供处理规则、Skills 和连接测试。

## 已实现

- 首次个人账户初始化、密码登录和 HttpOnly 会话
- 支持连接自己的 iLink Bot；每个连接独立长轮询
- 接收文字、图片、语音、文件和视频，下载并解密微信 CDN 附件
- SQLite 消息库、唯一约束、附件校验和、历史 JSONL 自动迁移
- 微信 Bot 凭据和 Nanobot API Key 使用 AES-256-GCM 加密；会话和插件令牌只存 SHA-256 哈希
- 可选 Nanobot 或 DeepSeek 等 OpenAI 兼容接口，自动生成标题、分类、标签、摘要和待办
- 后台 Skills 管理：区分真正执行的安全适配器与 AI 提示规则，支持启停、修改、恢复默认和自定义规则
- 微信公众号与公开网页正文安全抓取、清洗、Markdown 转换和派生附件同步
- 模型不可用时自动使用内置规则，不阻塞收件与同步，并可通过当前微信消息做去重提醒
- 可视化控制台：消息、微信账号、Agent、Skills 和同步设备
- 控制台支持图片、PDF、文本、音视频安全预览，其他附件下载
- 页面每 5 秒检测新消息并自动刷新概览和收件箱
- Obsidian 稳定批次、独立设备游标、ACK 后逻辑归档、修订覆盖和附件下载
- 轻量 Obsidian 插件：启动/定时/手动同步、模板优先、Markdown 派生附件、SHA-256 校验和断点重试

## 本机启动

需要 Node.js 22.13 或更高版本。

```bash
npm install
cp .env.example .env
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
5. 直接在同步页面下载插件，或按 [插件安装说明](./obsidian-plugin/README.md) 安装，填写服务地址和令牌。
6. 点击插件的“立即同步”。写入成功后，服务端消息会显示“已归档”。

插件默认优先使用当前 Vault 的 `90-系统/模板/T-快速捕获.md`。可在插件设置中关闭模板或更换路径；模板不可用时会自动回退，不会阻塞同步。

控制台“概览 → 账户安全”可以修改个人账户密码；修改后所有旧网页登录会话都会自动失效。

控制台“Skills”会显示默认启用的系统能力。其中“微信公众号安全解析器”和“通用网页安全解析器”是真正执行的适配器；其余是模型提示规则。修改或停用只影响之后收到的新消息，不追溯旧数据。

## Nanobot

系统按 HKUDS/nanobot 的 OpenAI 兼容接口接入。先单独安装并验证 Nanobot：

```bash
uv tool install nanobot-ai
nanobot webui
nanobot plugins enable api
nanobot serve
```

Nanobot 默认监听 `127.0.0.1:8900`。在控制台“AI Agent”填写：

```text
接口地址：http://127.0.0.1:8900/v1/
模型：以 Nanobot /v1/models 返回值为准
```

本机地址不要求 API Key；若 Nanobot 监听非本机地址，务必为它配置 API Key。个人版使用固定收件箱 `session_id`。本产品不开放通用 Agent 对话，也不会把对话混入收件箱。

出于 SSRF 防护，Nanobot 地址只能通过服务器的 `NANOBOT_BASE_URL` 配置；管理页面可设置模型、API Key 和处理规则。

项目附带一组经过审查、无脚本执行的场景 Skills，位于 `nanobot-skills/`。把需要的目录复制到 Nanobot workspace 的 `skills/` 后重启 Nanobot 即可加载：

```bash
mkdir -p nanobot-workspace/skills
cp -R nanobot-skills/* nanobot-workspace/skills/
```

包含收件分类、Obsidian 笔记、微信公众号公开文章和文档转 Markdown 规则。知流自己的网页适配器不依赖 Nanobot 工具调用；模型只负责理解、分类与摘要。

也可以直连 DeepSeek。编辑 `.env`：

```dotenv
NANOBOT_BASE_URL=https://api.deepseek.com/v1/
NANOBOT_API_KEY=请填写自己的密钥
NANOBOT_MODEL=deepseek-v4-flash
```

重启后在“AI Agent”页面启用并点击“测试连接”。密钥只放在 `.env` 或后台加密存储，不要写进镜像、源码和日志。

## 网页 Skills 的执行语义

- 两个请求的上游仓库已固定来源版本，但其脚本不会被直接执行或打包；详见 [THIRD_PARTY.md](./THIRD_PARTY.md)。
- 知流会校验 URL、DNS 的全部结果和每次重定向，拒绝本机、内网、保留地址、非标准端口与过大响应。
- 默认直接请求原网页，不会把 URL 发给 Jina、defuddle、markdown.new 等第三方 Reader。
- 网页内容被标记为不可信资料，正文中的 Agent 指令不会改变系统规则或触发工具。
- 只有模型成功分类后才保存派生 Markdown；模型失败时只保留原消息。

## Obsidian 同步语义

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

Compose 默认仅发布到宿主机 `127.0.0.1:8787`，数据保存在 `./data`。若要让 Nanobot 运行在另一个容器，请把两个服务放入同一 Docker 网络，并将 `NANOBOT_BASE_URL` 改为容器服务名。

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
- `data/state.json`、`data/inbox/*.jsonl`：旧版数据，仅用于首次迁移，不再作为主存储

## 当前产品边界

- iLink 协议按腾讯公开的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 实现；公开商业运营前应另外确认微信/iLink 的服务条款和限流规则。
- Agent Skills 应使用经过审查、固定版本的白名单，不要安装不可信的任意脚本。
- 复杂扫描 PDF、需要登录/验证码的网页和 SILK 语音转码属于后续可插拔处理器，消息接收和 Obsidian 同步本身不依赖这些能力。

安全、隐私和本轮十次迭代记录见 [SECURITY.md](./SECURITY.md)、[PRIVACY.md](./PRIVACY.md) 与 [docs/ITERATION-REPORT.md](./docs/ITERATION-REPORT.md)。
