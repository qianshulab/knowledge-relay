# 知流同步插件 1.3.1

知流同步把服务端收件台中的原始微信消息、Nanobot 整理结果、原附件和网页 Markdown 安全地写入指定 Obsidian 收件箱。插件不运行 Agent，也不决定分类规则；它只负责可靠同步和本地展示。

插件源码独立维护于 [qianshulab/knowledge-relay-obsidian](https://github.com/qianshulab/knowledge-relay-obsidian)。发布包采用单文件构建，`main.js` 已包含模板与同步模块，不会在 Obsidian 运行时加载 `template.cjs`。

## 安装与连接

1. 在知流“Obsidian 同步”页面下载插件 ZIP。
2. 解压后把 `wechat-ilink-inbox-sync` 放入 Vault 的 `.obsidian/plugins/`。
3. 重启 Obsidian，在“第三方插件”中启用“知流同步”。
4. 在知流创建一个 Obsidian 连接，复制只显示一次的 `obsidian_...` 令牌。
5. 在插件设置中填写服务地址和令牌，点击“立即同步”。

令牌已经绑定唯一连接，因此不用填写额外的 collectionId。非本机服务地址必须使用 HTTPS。

## 同步行为

- Obsidian 就绪后默认同步一次；周期同步默认关闭，启用后最短间隔为 5 分钟。
- 服务端先发布原始消息，再在 Nanobot 完成后发布同一远程 ID 的增强版本。插件会更新原笔记，不创建副本。
- 一批内容只有在笔记和附件全部成功写入后才 ACK；断网或 Obsidian 退出会在下次重放同一批。
- 去重只依赖服务端永久 ID，不依赖标题、路径或模型生成内容。
- 每个附件下载后校验 SHA-256；外部 Markdown 会移除脚本、危险深链和自动加载的远程图片。
- `restricted` 内容始终不会进入普通 Vault；其余敏感级别可在设置中限制。

## 托管区块

新笔记包含以下标记：

```markdown
<!-- knowledge-relay:managed:start -->
这里由知流维护
<!-- knowledge-relay:managed:end -->
```

后续版本只替换该区块和少量同步元数据。你的 `状态`、自定义 tags、`下一步`、勾选任务、临时备注和其他正文不会被覆盖。旧版笔记没有标记时，插件会报告冲突而不是整篇重写。

## 快速捕获模板

默认模板路径：

```text
90-系统/模板/T-快速捕获.md
```

插件会保留模板布局并注入托管区块。支持 `{{date}}`、`{{time}}`、`{{datetime}}`、`{{title}}`、`{{source}}`、`{{message_id}}` 和 `{{revision}}`。旧模板里的 `{{summary}}`、`{{content}}`、`{{attachments}}` 会清空，再由托管区块统一承载，避免后续修订覆盖用户内容。模板缺失时使用内置安全模板。

## 命令与恢复

命令面板提供：立即同步、查看同步状态、重新扫描本地同步记录、重置同步游标、打开收件箱、查看最近错误。

- 移出收件箱的笔记会标记为已处理，后续版本不会把它搬回来。
- 删除笔记会标记为已忽略，服务端重放不会重新创建。
- 误删插件本地索引时，先运行“重新扫描本地同步记录”。
- 只有需要完整重放时才使用“重置同步游标”；该操作有两次确认，本地远程 ID 索引仍会阻止重复笔记。

插件设置保存在 `.obsidian/plugins/wechat-ilink-inbox-sync/data.json`。Obsidian 当前没有通用系统钥匙串接口，因此令牌也保存在这里；它不会进入笔记、同步日志或 ACK。请保护 Vault 配置目录，设备丢失时立即在知流撤销连接。

## 本地开发

```bash
npm ci
npm run verify
npm run package
```

源码位于 `src/`。`npm run build` 使用 esbuild 生成仓库根目录的单文件 `main.js`；请勿手工编辑生成文件。`npm run package` 产出的 ZIP 只包含 Obsidian 运行所需文件，不包含源码模块。
