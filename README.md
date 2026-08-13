# 知流 · Knowledge Relay

知流是一个可自托管的个人知识收件台：接收发送给微信 iLink Bot 的文字、网页与附件，由官方 Nanobot Runtime 完成解析和智能整理，再可靠同步到指定的 Obsidian 收件箱。

> 当前版本：1.8.1 · 个人单用户版 · Node.js 22.13+ · Nanobot 0.3.0

## 产品能力

- 微信文字、图片、语音、文件和视频捕获，附件下载、解密与校验
- Nanobot 作为唯一 Agent Runtime，管理模型、Agent Loop、工具与原版 Skills
- 固定版本的 `wechat-article-extractor` 与 `fetch-skill`，可解析公众号和普通网页
- AI 入库时提取标题、摘要、分类、标签、专业领域、知识点与工具
- 首页知识地图，按领域、知识点和工具查看与筛选历史内容
- AI 收件检索：Nanobot 先理解需求、扩展关键词与结构化条件，再由本地索引匹配真实收件
- 最近捕获固定每页 10 条，使用稳定游标前后翻页，不会一次渲染全部历史消息
- 无模型或模型故障时保存原文、继续同步，并支持微信去重提醒
- Obsidian 批次同步、永久 ID 去重、修订更新、附件 SHA-256 校验与 ACK 归档
- 独立维护的单文件 Obsidian 插件，可在控制台下载或发布新版
- SQLite 本地存储、凭据加密、登录限速、安全响应头和 Docker 进程隔离

## 工作方式

```text
微信消息
  ↓
知流保存原文与附件
  ↓
Nanobot 选择 Skill、解析内容、调用模型
  ↓
结构化笔记 + 领域/知识点/工具 + 本地全文索引
  ├── Nanobot 理解检索意图 → 本地索引匹配
  └── Obsidian 增量同步
```

知流不会持续训练模型，也不会在查询时把整个收件箱交给模型。AI 在入库阶段完成语义整理；检索时独立的无工具 Nanobot Runtime 只把用户问题转换为关键词、同义词、分类、领域、工具和时间范围，真正的数据匹配由 SQLite 本地索引完成。这种“理解、规划、本地检索”的分层方式更容易控制隐私、延迟和成本，也不依赖平台可选的 SQLite 扩展。

微信目前只是第一个接入通道。业务核心已使用统一捕获模型，后续增加 API、RSS 或邮件接入时仍复用同一条持久化、Nanobot 整理、检索与 Obsidian 同步流水线。个人版与未来多用户版的隔离和演进方案见 [架构边界](./docs/ARCHITECTURE.md)。

## Docker 一键部署（推荐）

需要 Git、Docker Engine 及 Docker Compose v2。

```bash
git clone --recurse-submodules https://github.com/qianshulab/knowledge-relay.git
cd knowledge-relay
./scripts/deploy-docker.sh
```

脚本会：

1. 初始化两个固定版本的上游 Skill；
2. 创建 `.env` 并生成 Nanobot 内部鉴权密钥；
3. 构建并启动 `knowledge-relay` 与隔离的 `nanobot` sidecar；
4. 输出服务状态和访问地址。

打开 <http://127.0.0.1:8787> 创建个人账户。登录后在“系统设置 → AI 智能整理”配置 DeepSeek、OpenAI、Anthropic、OpenRouter、Gemini、Ollama 或自定义 OpenAI 兼容服务。

常用维护命令：

```bash
docker compose ps
docker compose logs -f --tail=200
docker compose pull
docker compose up -d --build
docker compose down
```

数据保存在宿主机 `data/` 与 Docker volume `nanobot-data`。升级前必须同时备份二者。

## 源码一键部署

适用于 macOS 或 Linux，需要 Git、Node.js 22.13+、npm 与 Python 3.11+。

```bash
git clone --recurse-submodules https://github.com/qianshulab/knowledge-relay.git
cd knowledge-relay
./scripts/deploy-source.sh
```

脚本会在项目内创建 `.nanobot-venv`，安装固定版本的 `nanobot-ai[api,documents]==0.3.0`，准备 Skills、安装依赖、构建并启动服务。服务以前台方式运行，按 `Ctrl+C` 可安全停止。

已有代码目录也可直接执行：

```bash
npm run deploy:docker
# 或
npm run deploy:source
```

开发模式：

```bash
npm ci
npm run setup:nanobot
npm run dev
```

## 第一次使用

1. 打开管理页面，创建唯一的个人账户。
2. 进入“系统设置 → 微信接入”，扫码连接自己的 iLink Bot。
3. 进入“系统设置 → AI 智能整理”，配置模型服务并检查连接。
4. 在 Skills 页面确认公众号与网页 Skill 已启用。
5. 给机器人发送一条消息，在收件台查看整理、知识地图和检索结果。
6. 打开“Obsidian”，下载插件并创建连接，将只显示一次的令牌填入插件设置。

## 收件箱检索助手

检索助手不是通用聊天机器人。它的固定链路是“Nanobot 理解问题 → 生成受限检索计划 → 本地索引匹配”，页面只提供查找与打开收件内容：

- 查询收件箱正文、标题、摘要和标签；
- 按分类、领域、知识点、工具与时间范围过滤；
- 对口语化问题扩展同义词、英文名和常见缩写；
- 返回匹配消息的摘要和可打开的原文引用。

检索 Runtime 使用官方 Nanobot AgentLoop 和同一模型配置，但启动时清空工具注册表，并与收件整理 workspace 隔离。检索计划还会经过字段、长度、分类和日期校验，页面不会执行计划之外的操作。模型未配置或暂时不可用时自动退回本地关键词与筛选规则；原始内容仍会进入索引，不影响基本搜索和 Obsidian 同步。

## Nanobot 与 Skills

知流不直连模型供应商。模型 Key、模型选择、工具调用与 Skill 执行都由 Nanobot 管理；主服务只连接本机 `127.0.0.1` 或 Compose 内精确命名的 `nanobot` 服务。

两个执行型 Skill 通过 Git submodule 固定版本：

- `external-skills/wechat-article-extractor`
- `external-skills/fetch-skill`

Docker 镜像已经准备它们所需的 Python、Node.js、npm 依赖和 Nanobot documents/API 组件。控制台编辑的是 Runtime 实际加载的完整 `SKILL.md`；启用、停用、编辑和恢复只影响之后收到的新消息。

上游 `fetch-skill` 的回退链可能把 URL 发送给第三方 Reader 服务。详情与固定 commit 见 [THIRD_PARTY.md](./THIRD_PARTY.md)。

## Obsidian 插件

插件源码与发布位于独立仓库：[qianshulab/knowledge-relay-obsidian](https://github.com/qianshulab/knowledge-relay-obsidian)。主仓库只固定引用验证过的插件版本，并在构建时生成可下载 ZIP。

新安装默认使用 Vault 中独立的 `90-系统/模板/T-知流收件.md`；已有自定义模板路径保持不变。同步特性包括：

- 单文件 `main.js`，无运行时相对模块依赖；
- 稳定批次、断点重试和 ACK；
- 永久消息 ID 去重，同一消息修订更新；
- 用户编辑区与知流托管区分离；
- 附件 SHA-256 校验和敏感级别限制。

协议与兼容规则见 [docs/API.md](./docs/API.md) 和 [docs/SYNC-AUDIT.md](./docs/SYNC-AUDIT.md)。

## 配置

常用环境变量：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `127.0.0.1` | 管理服务监听地址 |
| `PORT` | `8787` | 管理服务端口 |
| `DATA_DIR` | `./data` | 数据库、附件与密钥目录 |
| `PUBLIC_BASE_URL` | 空 | 公网 HTTPS 地址 |
| `NANOBOT_BASE_URL` | `http://127.0.0.1:8900/v1/` | 仅允许本机或内部 sidecar |
| `NANOBOT_SEARCH_BASE_URL` | `http://127.0.0.1:8902/v1/` | 无工具的检索意图 Runtime |
| `NANOBOT_RUNTIME_API_KEY` | 必填（Docker） | Nanobot 内部鉴权密钥 |
| `DEEPSEEK_API_KEY` | 空 | 可选的初始模型凭据，也可在页面配置 |
| `ILINK_ALLOW_FROM` | 扫码者本人 | 允许的微信用户 ID |
| `SYNC_BATCH_SIZE` | `100` | 单个 Obsidian 同步批次上限 |

完整示例见 [.env.example](./.env.example)。不要提交 `.env`、`data/app-secret.key` 或模型 Key。

## 安全与公网部署

- 默认只绑定 `127.0.0.1`；公网使用必须放在 HTTPS 反向代理后，并设置 `PUBLIC_BASE_URL`。
- `data/app-secret.key` 与 `data/inbox.sqlite` 必须成对备份；缺少主密钥将无法解密已有凭据。
- Obsidian 连接令牌等同于对应收件数据的读取权限，可在控制台随时撤销。
- Nanobot 工具运行在独立容器中，启用新的执行型 Skill 前应审查并固定版本。
- iLink 使用腾讯公开实现；公开商业运营前请自行确认服务条款与限流要求。

更多说明见 [SECURITY.md](./SECURITY.md)、[PRIVACY.md](./PRIVACY.md) 和 [THIRD_PARTY.md](./THIRD_PARTY.md)。

## 验证与健康检查

```bash
npm run verify
curl http://127.0.0.1:8787/health
```

`npm run verify` 会执行类型检查、48+ 项单元测试、服务构建、Nanobot 脚本检查以及 Obsidian 插件单文件校验。
GitHub Actions 会在每次提交和标签发布时重复验证，并分别构建 `linux/amd64` 与 `linux/arm64` 的主服务和 Nanobot 镜像。

## 数据目录

- `data/inbox.sqlite`：账户、消息、AI 元数据、本地检索索引和同步状态
- `data/app-secret.key`：本机凭据加密主密钥
- `data/media/`：微信原始附件
- `data/derived/`：解析生成的 Markdown 附件
- `data/plugin-release/`：后台发布的 Obsidian 插件包
- `data/nanobot/`：本机 Nanobot 配置、workspace、Skills 与 artifacts

## License

知流本体按 [MIT License](./LICENSE) 开源。第三方组件按各自许可证使用，详见 [THIRD_PARTY.md](./THIRD_PARTY.md)。
