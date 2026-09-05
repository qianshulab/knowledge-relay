import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, ExternalLink, FileArchive, Gem, KeyRound, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { api } from "../api";
import type { PluginRelease, SyncTarget } from "../types";
import { useApp } from "../App";
import { EmptyState, LoadingState, PageHeader, formatBytes, formatDate } from "../components/ui";
import { useConfirm } from "../components/ConfirmDialog";
import { useModalFocus } from "../components/useModalFocus";

export default function ObsidianPage() {
  const { owner, notify } = useApp();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<SyncTarget | null>(null);
  const [publisherOpen, setPublisherOpen] = useState(false);
  const [pluginArchive, setPluginArchive] = useState<File | null>(null);
  const publisherTriggerRef = useRef<HTMLButtonElement>(null);
  const release = useQuery({ queryKey: ["plugin-release"], queryFn: () => api<PluginRelease>("/api/plugin-release") });
  const targets = useQuery({ queryKey: ["sync-targets"], queryFn: () => api<{ targets: SyncTarget[] }>("/api/sync-targets") });
  const createTarget = useMutation({ mutationFn: (data: { name: string; folder: string }) => api<SyncTarget>("/api/sync-targets", { method: "POST", body: JSON.stringify({ ...data, primary: !targets.data?.targets.length }) }), onSuccess: (value) => { setCreated(value); notify("同步设备已创建，请立即保存令牌", "success"); void queryClient.invalidateQueries({ queryKey: ["sync-targets"] }); }, onError: (error) => notify(error instanceof Error ? error.message : "同步设备创建失败，请重试", "danger") });
  const publishPlugin = useMutation({
    mutationFn: (file: File) => api<PluginRelease>("/api/plugin-release", { method: "POST", headers: { "Content-Type": "application/zip" }, body: file }),
    onSuccess: (value) => {
      queryClient.setQueryData(["plugin-release"], value);
      notify(`知流同步插件 v${value.version || "新版"} 已发布`, "success");
      setPluginArchive(null);
      setPublisherOpen(false);
    },
    onError: (error) => notify(error instanceof Error ? error.message : "插件发布失败", "danger"),
  });
  const publisherModalRef = useModalFocus<HTMLElement>({
    open: publisherOpen,
    onClose: () => setPublisherOpen(false),
    returnFocusRef: publisherTriggerRef,
    canClose: !publishPlugin.isPending,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createTarget.mutate({ name: String(form.get("name") || ""), folder: String(form.get("folder") || "Inbox") });
    event.currentTarget.reset();
  }

  async function revoke(id: string) {
    if (!await confirm({ title: "撤销这个同步设备？", description: "设备令牌会立即失效，该设备将无法继续同步；已写入 Vault 的文件不会删除。", confirmLabel: "撤销设备", tone: "danger" })) return;
    try {
      await api(`/api/sync-targets/${id}`, { method: "DELETE" });
      notify("同步设备已撤销", "success");
      void queryClient.invalidateQueries({ queryKey: ["sync-targets"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "同步设备撤销失败，请重试", "danger");
    }
  }

  async function submitPlugin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pluginArchive) return notify("请选择插件 ZIP 安装包", "danger");
    if (!pluginArchive.name.toLowerCase().endsWith(".zip")) return notify("只支持 ZIP 安装包", "danger");
    if (pluginArchive.size > 10 * 1024 * 1024) return notify("插件 ZIP 不能超过 10 MB", "danger");
    if (!await confirm({ title: "发布这个插件版本？", description: "服务端校验通过后，该安装包会立即成为所有用户下载的最新版本。", confirmLabel: "校验并发布" })) return;
    publishPlugin.mutate(pluginArchive);
  }

  return <main className="page obsidian-page"><PageHeader eyebrow="OBSIDIAN SYNC" title="Obsidian 同步" description="将已整理的知识可靠同步到你的 Vault。网页知识库可以独立使用，Obsidian 是可选的扩展。" />
    <section className="setup-grid"><article className="panel plugin-card"><div className="product-icon" aria-hidden="true"><Gem size={27} /></div><div><span className="eyebrow">OFFICIAL PLUGIN</span><h2>知流同步插件</h2><p>接收结构化笔记、原文快照与本地附件，支持增量同步和可靠确认。</p><div className="plugin-meta"><span>{release.isPending ? "正在读取版本" : release.isError && !release.data ? "版本信息不可用" : release.data?.available ? `版本 ${release.data.version}` : "尚未发布"}</span><span>Windows · macOS · Linux</span></div></div><div className="plugin-actions">{release.data?.available && <a className="button button-primary" href={release.data.downloadUrl || "/downloads/knowledge-relay-obsidian.zip"}><Download size={17} />下载安装包</a>}{release.isError && !release.data && <button className="button button-secondary" onClick={() => void release.refetch()}><RefreshCw size={17} />重新读取</button>}{owner.role === "admin" && <button ref={publisherTriggerRef} className="button button-secondary" onClick={() => setPublisherOpen(true)}><Upload size={17} />发布新版</button>}</div></article><article className="panel steps-card"><span className="eyebrow">QUICK START</span><h2>三步完成连接</h2><ol><li><span>1</span><div><strong>安装插件</strong><small>解压到 Vault 的 .obsidian/plugins 目录。</small></div></li><li><span>2</span><div><strong>创建同步设备</strong><small>为每个 Vault 使用独立令牌。</small></div></li><li><span>3</span><div><strong>填写服务地址与令牌</strong><small>插件会自动拉取新增和更新内容。</small></div></li></ol></article></section>
    <section className="content-section"><div className="section-heading"><div><span className="eyebrow">SYNC TARGETS</span><h2>同步设备</h2><p>令牌只在创建时显示一次，请存入 Obsidian 插件设置。</p></div></div>{created?.token && <div className="secret-reveal"><KeyRound size={20} /><div><strong>新同步令牌</strong><code>{created.token}</code><small>关闭此提示后将无法再次查看。</small></div><button className="button button-secondary" onClick={() => { void navigator.clipboard.writeText(created.token || ""); notify("令牌已复制", "success"); }}><Copy size={17} />复制</button><button className="icon-button" onClick={() => setCreated(null)}><Check size={18} /></button></div>}<form className="inline-create-form" onSubmit={submit}><label>设备名称<input name="name" required placeholder="例如：主知识库" /></label><label>同步文件夹<input name="folder" required defaultValue="Inbox" /></label><button className="button button-primary" disabled={createTarget.isPending}><Plus size={17} />{createTarget.isPending ? "正在创建…" : "创建设备"}</button></form>{targets.isPending ? <LoadingState label="正在读取同步设备" /> : targets.isError && !targets.data ? <EmptyState title="同步设备加载失败" description={targets.error instanceof Error ? targets.error.message : "暂时无法读取同步设备，请稍后重试。"} action={<button className="button button-secondary" onClick={() => void targets.refetch()}><RefreshCw size={16} />重新加载</button>} /> : targets.data?.targets.length ? <div className="target-list">{targets.data.targets.map((target) => <div key={target.id}><div className="target-icon"><ExternalLink size={19} /></div><div><strong>{target.name}</strong><p>写入目录：{target.folder}</p></div><span className="target-seen">{target.lastSeenAt ? `最近同步 ${formatDate(target.lastSeenAt)}` : "尚未同步"}</span><button className="icon-button danger-text" onClick={() => void revoke(target.id)} aria-label="撤销设备"><Trash2 size={18} /></button></div>)}</div> : <EmptyState title="还没有同步设备" description="创建第一个同步设备后，在 Obsidian 插件中填写服务地址与令牌。" />}</section>
    {publisherOpen && owner.role === "admin" && <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget && !publishPlugin.isPending) setPublisherOpen(false); }}><section ref={publisherModalRef} className="plugin-publish-modal" role="dialog" aria-modal="true" aria-label="发布 Obsidian 插件新版" tabIndex={-1}><header><div><span className="eyebrow">PLUGIN RELEASE</span><h2>发布插件新版</h2><p>上传 ZIP 后，服务端会校验插件结构、ID、版本号和文件完整性。</p></div><button className="icon-button" data-modal-initial-focus disabled={publishPlugin.isPending} onClick={() => setPublisherOpen(false)} aria-label="关闭"><X size={20} /></button></header><div className="release-summary"><div><span>当前版本</span><strong>{release.data?.version ? `v${release.data.version}` : "尚未发布"}</strong></div><div><span>安装包大小</span><strong>{release.data?.size ? formatBytes(release.data.size) : "—"}</strong></div><div><span>发布时间</span><strong>{release.data?.publishedAt ? formatDate(release.data.publishedAt) : "—"}</strong></div></div><form onSubmit={(event) => void submitPlugin(event)}><label className="plugin-upload-field"><input type="file" accept=".zip,application/zip" onChange={(event) => setPluginArchive(event.target.files?.[0] || null)} /><FileArchive size={25} /><span><strong>{pluginArchive?.name || "选择插件 ZIP 安装包"}</strong><small>{pluginArchive ? `${formatBytes(pluginArchive.size)} · 等待校验` : "最大 10 MB；必须包含 manifest.json 与 main.js"}</small></span></label><ul className="release-rules"><li>插件 ID 必须为 wechat-ilink-inbox-sync</li><li>版本号必须高于当前版本，不允许用相同版本覆盖不同内容</li><li>校验成功后立即成为所有用户的下载版本</li></ul><footer><button type="button" className="button button-secondary" disabled={publishPlugin.isPending} onClick={() => setPublisherOpen(false)}>取消</button><button className="button button-primary" disabled={!pluginArchive || publishPlugin.isPending}><Upload size={17} />{publishPlugin.isPending ? "校验并发布中…" : "校验并发布"}</button></footer></form></section></div>}
  </main>;
}
