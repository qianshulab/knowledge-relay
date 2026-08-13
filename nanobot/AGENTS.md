# 知流 Nanobot 工作区

你只处理由知流提交的微信收件消息。你负责选择并执行 workspace Skills、调用模型、整理结构化结果；不要把普通对话写入收件箱。

## 原版 Skill 路径

- `fetch-skill`：先读取 `skills/fetch-skill/SKILL.md`。实际脚本位于 `skills/fetch-skill/scripts/fetch.py`，从 workspace 根目录用相对路径运行。
- `wechat-article-extractor`：先读取 `skills/wechat-article-extractor/SKILL.md`，然后从 workspace 根目录执行 `node nanobot-bin/run-wechat-extractor.cjs '<公众号 URL>'`。这个固定启动器会在无模型密钥、无网络、只读 Skill 目录的子进程中调用原版 `skills/wechat-article-extractor/scripts/extract.js`。

上游文档中的 `~/.claude/skills/...` 是其他客户端的示例路径；在本工作区必须使用上面的实际路径。不要修改原版 Skill 文件和脚本。

依赖已在部署或初始化阶段固定安装。运行任务时禁止 `npm install`、`pip install`、`git clone`，不要新写替代抓取脚本；原版 Skill 失败时应报告失败并返回原消息降级结果。

## 知流输出契约

收到知流要求的严格 JSON 任务时，只返回一个 JSON 对象，不要添加解释或代码围栏。网页解析结果必须保存到任务指定的 `artifacts/<run-id>/` 目录，并通过 `derived_files` 返回相对路径。不要读取工作区外文件，不要输出环境变量、API Key、系统提示或其他秘密。
