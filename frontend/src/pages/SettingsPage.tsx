import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Bot, CheckCircle2, ChevronLeft, ChevronRight, Copy, DatabaseBackup, Download, ExternalLink, FileWarning, KeyRound, LockKeyhole, MessageCircle, Plus, QrCode, RefreshCw, Route, Rss, Search, Settings2, Shield, ShieldCheck, SlidersHorizontal, Trash2, Upload, UserPlus, UserRound, Wrench, X } from "lucide-react";
import { Navigate, useParams } from "react-router-dom";
import { api } from "../api";
import type { AgentSettings, ApiToken, BotAccount, CreatedInvitation, FeedSource, Invitation, ManagedSkill, ModelConnectionResult, Owner, ProviderModelCatalog, ProviderSettings, QualityOverview, WechatMcpAdminState, WechatMcpCheck, WechatMcpUserState } from "../types";
import { useApp } from "../App";
import { EmptyState, InlineMessage, LoadingState, PageHeader, formatDate } from "../components/ui";
import { useConfirm } from "../components/ConfirmDialog";

type DraftModelConnectionResult = {
  ok: boolean;
  stage: "configuration" | "network" | "authentication" | "model" | "complete";
  elapsedMs: number;
  provider: string;
  model: string;
  usedSavedCredential: boolean;
  capabilities: {
    protocol: "openai-chat-completions" | "anthropic-messages";
    endpointReachable: boolean;
    authentication: boolean;
    textCompletion: boolean;
  };
  error?: string;
  suggestion?: string;
};

function isDraftConnection(value: ModelConnectionResult | DraftModelConnectionResult): value is DraftModelConnectionResult {
  return "capabilities" in value;
}

export default function SettingsPage() {
  const { section = "intake" } = useParams();
  const { owner } = useApp();
  const currentSection = ["sources", "api"].includes(section) ? "intake" : section;
  if (currentSection === "users" && owner.role !== "admin") return <Navigate to="/settings/account" replace />;
  if (!["intake", "ai", "skills", "quality", "data", "users", "account"].includes(currentSection)) {
    return <Navigate to="/settings/intake" replace />;
  }
  return <main className="page settings-page"><PageHeader eyebrow="SYSTEM SETTINGS" title="系统设置" description="管理收件接入、智能整理、内容质量、数据与账户安全。" /><div className="settings-content">{currentSection === "intake" ? <IntakeSettings /> : currentSection === "ai" ? <AiSettings /> : currentSection === "skills" ? <SkillsSettings /> : currentSection === "quality" ? <QualitySettings /> : currentSection === "data" ? <DataSettings /> : currentSection === "users" && owner.role === "admin" ? <UsersSettings /> : <AccountSettings />}</div></main>;
}

function SettingsHeader({ title, description }: { title: string; description: string }) { return <div className="settings-heading"><h2>{title}</h2><p>{description}</p></div>; }

function SettingsLoadError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  return <EmptyState icon={<AlertTriangle size={25} />} title={title} description={error instanceof Error ? error.message : "服务暂时没有返回配置，请稍后重试。"} action={<button className="button button-secondary" type="button" onClick={onRetry}><RefreshCw size={16} />重新加载</button>} />;
}

const qualityIssueLabels: Record<string, string> = {
  failed: "整理失败",
  fallback: "使用了基础整理",
  missing_summary: "缺少摘要",
  missing_cover: "缺少正文图片",
  missing_body: "正文内容不完整",
  broken_asset: "存在失效图片引用",
  warning: "存在内容警告",
  unindexed: "尚未建立问答索引",
};

function QualitySettings() {
  const { notify } = useApp();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const quality = useQuery({ queryKey: ["quality-overview"], queryFn: () => api<QualityOverview>("/api/quality/overview"), refetchInterval: 20_000 });
  const reprocess = useMutation({
    mutationFn: (messageIds: string[]) => api<{ count: number }>("/api/quality/reprocess", { method: "POST", body: JSON.stringify({ messageIds }) }),
    onSuccess: (result) => {
      notify(`已将 ${result.count} 条内容加入重新整理队列`, "success");
      setSelected([]);
      void queryClient.invalidateQueries({ queryKey: ["quality-overview"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) => notify(error instanceof Error ? error.message : "提交失败", "danger"),
  });
  const value = quality.data;
  const repairable = value?.issues.filter((item) => item.issues.some((issue) => issue !== "missing_cover")) || [];
  const allSelected = Boolean(repairable.length) && repairable.every((item) => selected.includes(item.id));
  return <><SettingsHeader title="内容质量" description="集中发现解析、整理、图片与问答索引问题，并从同一个位置修复。" />
    {quality.isLoading ? <LoadingState label="正在检查内容质量" /> : value ? <>
      <section className="quality-metrics">
        <div className="settings-card"><ShieldCheck size={20} /><span>健康内容</span><strong>{value.healthy}</strong><small>共 {value.total} 条</small></div>
        <div className="settings-card"><Activity size={20} /><span>正在处理</span><strong>{value.processing}</strong><small>后台任务会自动更新</small></div>
        <div className="settings-card"><AlertTriangle size={20} /><span>需要处理</span><strong>{value.issues.length}</strong><small>{value.failed + value.fallback} 条整理异常</small></div>
        <div className="settings-card"><FileWarning size={20} /><span>内容完整性</span><strong>{value.missingCover + value.missingSummary + value.missingBody + value.brokenAssets}</strong><small>{value.unindexed} 条未建问答索引</small></div>
      </section>
      {value.duplicateReceipts > 0 && <InlineMessage tone="default">已自动合并 {value.duplicateReceipts} 次重复收件，涉及 {value.duplicateMessages} 条内容；相同链接不会重复调用 AI。</InlineMessage>}
      <section className="settings-card quality-list-card">
        <div className="settings-card-title"><Activity size={19} /><div><h3>问题清单</h3><p>只展示需要关注的内容；正文图片缺失通常需要重新抓取原网页。</p></div>{repairable.length > 0 && <button className="button button-secondary" disabled={reprocess.isPending} onClick={() => reprocess.mutate(selected.length ? selected : repairable.map((item) => item.id))}><RefreshCw className={reprocess.isPending ? "spin" : ""} size={16} />{selected.length ? `重新整理 ${selected.length} 条` : "修复可处理项"}</button>}</div>
        {repairable.length > 1 && <label className="quality-select-all"><input type="checkbox" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? repairable.map((item) => item.id) : [])} />选择全部可重新整理的内容</label>}
        {value.issues.length ? <div className="quality-issue-list">{value.issues.map((item) => <div key={item.id}>
          <label><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /><span><strong>{item.title}</strong><small>{item.agentError || item.summary || "等待补齐内容信息"}</small></span></label>
          <div className="tag-row">{item.issues.map((issue) => <span key={issue}>{qualityIssueLabels[issue] || issue}</span>)}</div>
          <a className="button button-secondary" href={`/reader/${encodeURIComponent(item.id)}`}>查看</a>
        </div>)}</div> : <EmptyState icon={<CheckCircle2 size={28} />} title="内容状态良好" description="暂未发现需要人工处理的问题。" />}
      </section>
    </> : <InlineMessage tone="danger">内容质量检查暂时不可用。</InlineMessage>}
  </>;
}

function DataSettings() {
  const { owner, notify } = useApp();
  const [preview, setPreview] = useState<{ messages: number; annotations: number; collections: number; exportedAt?: string } | null>(null);
  async function inspect(file?: File) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text()) as Record<string, unknown>;
      if (payload.format !== "knowledge-relay-personal-export") throw new Error("这不是知流个人数据导出文件");
      setPreview({
        messages: Array.isArray(payload.messages) ? payload.messages.length : 0,
        annotations: Array.isArray(payload.annotations) ? payload.annotations.length : 0,
        collections: Array.isArray(payload.collections) ? payload.collections.length : 0,
        exportedAt: typeof payload.exportedAt === "string" ? payload.exportedAt : undefined,
      });
      notify("备份文件校验通过", "success");
    } catch (error) { setPreview(null); notify(error instanceof Error ? error.message : "备份文件无法读取", "danger"); }
  }
  return <><SettingsHeader title="数据与备份" description="导出个人知识资产，校验历史备份，并为服务器完整恢复保留明确入口。" />
    <section className="settings-card backup-hero"><div className="settings-card-title"><DatabaseBackup size={20} /><div><h3>个人数据导出</h3><p>包含整理内容、标注、智能集合与问答记录，不包含附件二进制文件。</p></div><a className="button button-primary" href="/api/account/export" download><Download size={17} />下载个人数据</a></div><InlineMessage tone="default">建议在重大升级前导出一次。完整附件与数据库仍应使用服务器备份脚本保存。</InlineMessage></section>
    <section className="settings-card"><div className="settings-card-title"><ShieldCheck size={19} /><div><h3>恢复前校验</h3><p>先检查导出文件的格式与内容数量，不会在浏览器中直接覆盖现有数据。</p></div><label className="button button-secondary backup-file-button"><Upload size={17} />选择备份文件<input type="file" accept="application/json,.json" onChange={(event) => { void inspect(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label></div>{preview && <div className="backup-preview"><CheckCircle2 size={22} /><div><strong>备份文件可读取</strong><span>{preview.messages} 条内容 · {preview.annotations} 条标注 · {preview.collections} 个集合{preview.exportedAt ? ` · 导出于 ${formatDate(preview.exportedAt)}` : ""}</span></div></div>}</section>
    {owner.role === "admin" && <section className="settings-card server-backup-card"><div className="settings-card-title"><DatabaseBackup size={19} /><div><h3>服务器完整备份</h3><p>包含 SQLite 数据库、原始附件、正文图片、Nanobot 工作区和密钥文件。</p></div></div><ol><li>在部署目录执行 <code>./scripts/backup-docker.sh</code>。</li><li>将生成的备份包复制到另一台设备或异地存储。</li><li>恢复前先停止服务，再使用 <code>./scripts/restore-docker.sh 备份包路径</code>。</li></ol><InlineMessage tone="danger">恢复会替换服务器当前数据，必须先创建最新备份并确认目标文件。</InlineMessage></section>}
  </>;
}

function IntakeSettings() {
  return <><SettingsHeader title="收件接入" description="通过微信、自动订阅或开放 API，把链接、文字与附件汇入同一个收件台。" /><div className="intake-stack"><SourcesSettings /><FeedSourcesSettings /><WechatAssistantSettings /><ApiSettings /></div></>;
}

function FeedSourcesSettings() {
  const { notify } = useApp();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const sources = useQuery({ queryKey: ["feed-sources"], queryFn: () => api<{ sources: FeedSource[] }>("/api/feed-sources"), refetchInterval: 30_000 });
  const create = useMutation({
    mutationFn: (input: { name: string; feedUrl: string; intervalMinutes: number }) => api<{ source: FeedSource }>("/api/feed-sources", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => { notify("自动来源已添加，正在执行首次检查", "success"); void queryClient.invalidateQueries({ queryKey: ["feed-sources"] }); },
    onError: (error) => notify(error instanceof Error ? error.message : "添加自动来源失败", "danger"),
  });
  const update = useMutation({
    mutationFn: ({ id, ...input }: { id: string; enabled: boolean }) => api(`/api/feed-sources/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["feed-sources"] }),
    onError: (error) => notify(error instanceof Error ? error.message : "来源状态更新失败", "danger"),
  });
  const check = useMutation({
    mutationFn: (id: string) => api<{ accepted: boolean; sourceId: string }>(`/api/feed-sources/${encodeURIComponent(id)}/check`, { method: "POST" }),
    onSuccess: () => { notify("来源检查已进入任务中心", "success"); void queryClient.invalidateQueries({ queryKey: ["feed-sources"] }); void queryClient.invalidateQueries({ queryKey: ["background-jobs"] }); },
    onError: (error) => notify(error instanceof Error ? error.message : "订阅检查失败", "danger"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/feed-sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => { notify("自动来源已移除，已接收内容不会删除", "success"); void queryClient.invalidateQueries({ queryKey: ["feed-sources"] }); },
    onError: (error) => notify(error instanceof Error ? error.message : "自动来源移除失败", "danger"),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      name: String(form.get("name") || ""),
      feedUrl: String(form.get("feedUrl") || ""),
      intervalMinutes: Number(form.get("intervalMinutes")) || 60,
    });
    event.currentTarget.reset();
  }
  async function removeSource(source: FeedSource) {
    const accepted = await confirm({
      title: "移除这个自动来源？",
      description: `知流将停止检查“${source.name}”，已经接收和整理的内容会完整保留。`,
      confirmLabel: "移除来源",
      tone: "danger",
    });
    if (accepted) remove.mutate(source.id);
  }
  return <section className="settings-card feed-source-card"><div className="settings-card-head"><Rss size={20} /><div><h3>自动来源</h3><p>订阅 RSS 或 Atom，新文章会自动进入收件台并沿用同一套整理与去重流程。</p></div></div><form className="feed-source-create" onSubmit={submit}><label>来源名称<input name="name" maxLength={80} placeholder="例如：团队技术博客" /></label><label className="feed-url-field">订阅地址<input name="feedUrl" type="url" required placeholder="https://example.com/feed.xml" /></label><label>检查频率<select name="intervalMinutes" defaultValue="60"><option value="30">每 30 分钟</option><option value="60">每小时</option><option value="360">每 6 小时</option><option value="1440">每天</option></select></label><button className="button button-primary" disabled={create.isPending}><Plus size={16} />{create.isPending ? "添加中…" : "添加来源"}</button></form>{sources.isLoading ? <LoadingState label="正在读取自动来源" /> : sources.isError ? <SettingsLoadError title="自动来源加载失败" error={sources.error} onRetry={() => void sources.refetch()} /> : sources.data?.sources.length ? <div className="feed-source-list">{sources.data.sources.map((source) => <article key={source.id}><div className={`source-health ${source.lastError ? "error" : source.enabled ? "active" : "paused"}`}><Rss size={17} /></div><div><div className="source-title"><strong>{source.name}</strong><span className={`status-badge ${source.lastError ? "danger" : source.enabled ? "success" : ""}`}>{source.lastError ? "检查异常" : source.enabled ? "自动检查" : "已暂停"}</span></div><a href={source.feedUrl} target="_blank" rel="noreferrer">{source.feedUrl}</a><small>{source.lastError || (source.lastCheckedAt ? `最近检查 ${formatDate(source.lastCheckedAt)}` : "等待首次检查")} · 每 {source.intervalMinutes < 60 ? `${source.intervalMinutes} 分钟` : source.intervalMinutes === 60 ? "小时" : source.intervalMinutes === 1440 ? "天" : `${source.intervalMinutes / 60} 小时`}</small></div><div className="source-actions"><button className="button button-secondary" disabled={check.isPending} onClick={() => check.mutate(source.id)}><RefreshCw className={check.isPending ? "spin" : ""} size={15} />立即检查</button><button className="button button-secondary" onClick={() => update.mutate({ id: source.id, enabled: !source.enabled })}>{source.enabled ? "暂停" : "启用"}</button><button className="icon-button danger-text" aria-label={`删除来源${source.name}`} onClick={() => void removeSource(source)}><Trash2 size={16} /></button></div></article>)}</div> : <EmptyState icon={<Rss size={26} />} title="尚未添加自动来源" description="添加博客、新闻站或项目更新的 RSS / Atom 地址后，系统会定期检查新内容。" />}</section>;
}

function SourcesSettings() {
  const { notify } = useApp(); const queryClient = useQueryClient();
  const confirm = useConfirm();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api<{ accounts: BotAccount[] }>("/api/dashboard") });
  const [session, setSession] = useState<{ sessionId: string; qrUrl?: string } | null>(null);
  async function start() {
    try {
      const value = await api<{ sessionId: string }>("/api/ilink/login/start", { method: "POST" });
      setSession({ sessionId: value.sessionId, qrUrl: `/api/ilink/login/${value.sessionId}/qr.svg` });
    } catch (error) {
      notify(error instanceof Error ? error.message : "微信连接启动失败", "danger");
    }
  }
  async function disconnect(account: BotAccount) {
    if (!await confirm({ title: "断开这个微信账号？", description: "断开后将停止接收该账号的新消息，已保存的内容不会受到影响。", confirmLabel: "断开账号", tone: "danger" })) return;
    try {
      await api(`/api/ilink/accounts/${account.id}`, { method: "DELETE" });
      notify("微信账号已断开", "success");
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "微信账号断开失败", "danger");
    }
  }
  useEffect(() => { if (!session) return; const timer = window.setInterval(async () => { try { const status = await api<{ status: string }>(`/api/ilink/login/${session.sessionId}/status`); if (["connected", "confirmed", "success"].includes(status.status)) { setSession(null); notify("微信 iLink 已连接", "success"); void queryClient.invalidateQueries({ queryKey: ["dashboard"] }); } } catch { /* login session may briefly rotate */ } }, 2500); return () => window.clearInterval(timer); }, [notify, queryClient, session]);
  return <section className="settings-card"><div className="settings-card-head"><MessageCircle size={20} /><div><h3>微信 iLink</h3><p>把消息、公众号文章和附件发送给 iLink Bot。</p></div><button className="button button-primary" onClick={() => void start()}><Plus size={17} />连接微信</button></div>{session?.qrUrl && <div className="qr-connect"><img src={session.qrUrl} alt="微信 iLink 登录二维码" /><div><strong>使用微信扫码连接</strong><p>扫码后按微信提示完成确认，此页面会自动更新。</p></div></div>}<div className="section-caption source-section-caption"><strong>连接状态</strong><span>{dashboard.data?.accounts.length ? `${dashboard.data.accounts.length} 个微信账号正在接收` : "连接账号后开始接收"}</span></div>{dashboard.isLoading ? <LoadingState /> : dashboard.isError ? <SettingsLoadError title="微信连接状态加载失败" error={dashboard.error} onRetry={() => void dashboard.refetch()} /> : dashboard.data?.accounts.length ? <div className="source-list">{dashboard.data.accounts.map((account) => <div key={account.id}><CheckCircle2 size={19} /><div><strong>{account.botId}</strong><span>连接于 {formatDate(account.connectedAt)}</span></div><span className="status-badge success">已连接</span><button className="icon-button danger-text" aria-label="断开微信账号" onClick={() => void disconnect(account)}><Trash2 size={17} /></button></div>)}</div> : <EmptyState title="尚未连接微信" description="连接后即可通过微信发送内容。" />}</section>;
}

function WechatAssistantSettings() {
  const { owner, notify } = useApp();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ["wechat-mcp-state"], queryFn: () => api<WechatMcpUserState>("/api/wechat-mcp"), refetchInterval: 10_000 });
  const admin = useQuery({ queryKey: ["wechat-mcp-admin"], queryFn: () => api<WechatMcpAdminState>("/api/admin/wechat-mcp"), enabled: owner.role === "admin", refetchInterval: 10_000 });
  const [form, setForm] = useState({ endpoint: "", authorization: "", displayName: "知流助手", account: "", pollIntervalSeconds: 8, enabled: false });
  const [connection, setConnection] = useState<WechatMcpCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [bindingCode, setBindingCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [bindingSearch, setBindingSearch] = useState("");
  const qrInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const source = admin.data?.source;
    if (!source) return;
    setForm({ endpoint: source.endpoint, authorization: "", displayName: source.displayName, account: source.account, pollIntervalSeconds: source.pollIntervalSeconds, enabled: source.enabled });
  }, [admin.data?.source]);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["wechat-mcp-state"] }),
      queryClient.invalidateQueries({ queryKey: ["wechat-mcp-admin"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    ]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await api("/api/admin/wechat-mcp", { method: "PUT", body: JSON.stringify(form) });
      notify("微信助手 MCP 配置已保存", "success");
      setForm((current) => ({ ...current, authorization: "" }));
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "配置保存失败", "danger"); }
  }

  async function check() {
    setChecking(true); setConnection(null);
    try {
      const result = await api<WechatMcpCheck>("/api/admin/wechat-mcp/check", { method: "POST", body: JSON.stringify(form) });
      setConnection(result);
      if (!form.account && result.accounts[0]) setForm((current) => ({ ...current, account: result.accounts[0] || "" }));
      notify(`连接正常，发现 ${result.accountCount} 个微信账号`, "success");
    } catch (error) { notify(error instanceof Error ? error.message : "MCP 连接失败", "danger"); }
    finally { setChecking(false); }
  }

  async function uploadQr(file?: File) {
    if (!file) return;
    try {
      await api("/api/admin/wechat-mcp/assistant-qr", { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      notify("助手二维码已更新", "success");
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "二维码上传失败", "danger"); }
  }

  async function generateCode() {
    try {
      const result = await api<{ code: string; expiresAt: string }>("/api/wechat-mcp/binding-code", { method: "POST" });
      setBindingCode(result);
    } catch (error) { notify(error instanceof Error ? error.message : "绑定码生成失败", "danger"); }
  }

  async function unbind(id?: string) {
    if (!await confirm({ title: "解除微信联系人绑定？", description: "解除后，该联系人发送的新内容将不再进入对应用户的收件台；历史内容会保留。", confirmLabel: "解除绑定", tone: "danger" })) return;
    try {
      await api(id ? `/api/admin/wechat-mcp/bindings/${id}` : "/api/wechat-mcp/binding", { method: "DELETE" });
      setBindingCode(null); notify("微信助手绑定已解除", "success"); await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "解除绑定失败", "danger"); }
  }

  const source = admin.data?.source;
  const binding = state.data?.binding;
  const latestError = source?.lastError || state.data?.source?.lastError;
  const latestPoll = source?.lastPollAt || state.data?.source?.lastPollAt;
  const qrConfigured = source?.qrConfigured ?? state.data?.source?.qrConfigured ?? false;
  const adminUsers = admin.data?.users || [];
  const boundUsers = adminUsers.filter((item) => Boolean(item.binding));
  const visibleAdminUsers = adminUsers.filter((item) => {
    const needle = bindingSearch.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return true;
    return [item.username, item.userDisplayName, item.binding?.wechatDisplayName]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase("zh-CN").includes(needle));
  });
  const runtimeLabel = !source && owner.role === "admin"
    ? "尚未配置"
    : latestError
      ? "接收异常"
      : state.data?.available
        ? latestPoll ? "运行中" : "等待首次轮询"
        : source?.enabled ? "等待二维码" : "已停用";
  return <section className="settings-card wechat-assistant-card">
    <div className="settings-card-title"><Bot size={20} /><div><h3>微信助手</h3><p>添加统一的知流助手微信，通过一次性绑定码把联系人安全路由到各自的知流账户。</p></div><span className={`status-badge ${latestError ? "warning" : state.data?.available ? "success" : ""}`}>{runtimeLabel}</span></div>
    <div className="intake-status-grid" aria-label="微信助手配置状态">
      <div><span>接收服务</span><strong>{runtimeLabel}</strong><small>{latestError ? "最近轮询失败" : source?.enabled || state.data?.available ? "后台持续接收新消息" : "保存并启用后开始接收"}</small></div>
      <div><span>服务轮询</span><strong>{latestPoll ? "已建立" : "尚未建立"}</strong><small>{latestPoll ? `最近 ${formatDate(latestPoll)}` : "等待首次成功连接"}</small></div>
      <div><span>助手二维码</span><strong>{qrConfigured ? "已配置" : "未配置"}</strong><small>{qrConfigured ? "用户可扫码添加助手" : "需由管理员上传"}</small></div>
      <div><span>用户绑定</span><strong>{owner.role === "admin" ? admin.isLoading ? "正在读取" : `${boundUsers.length}/${adminUsers.length} 已绑定` : binding ? "已绑定" : "未绑定"}</strong><small>{binding ? binding.wechatDisplayName : "绑定后才会路由消息"}</small></div>
    </div>
    {owner.role === "admin" && (admin.isLoading ? <LoadingState label="正在读取微信助手配置" /> : admin.isError ? <SettingsLoadError title="微信助手管理状态加载失败" error={admin.error} onRetry={() => void admin.refetch()} /> : <div className="wechat-mcp-admin">
      <div className="section-caption"><strong>连接配置</strong><span>仅管理员可修改；Authorization 加密保存在服务器，不会返回浏览器。</span></div>
      <form className="settings-form" onSubmit={(event) => void save(event)}>
        <label>MCP Endpoint<input type="url" required value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value })} placeholder="https://example.com/mcp" /></label>
        <label>Authorization<input type="password" value={form.authorization} onChange={(event) => setForm({ ...form, authorization: event.target.value })} placeholder={source?.authorizationConfigured ? "已配置，留空保持不变" : "Bearer token"} /></label>
        <div className="form-grid"><label>助手名称<input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label><label>微信账号<select value={form.account} onChange={(event) => setForm({ ...form, account: event.target.value })}><option value="">自动选择</option>{connection?.accounts.map((account) => <option key={account} value={account}>{account}</option>)}{source?.account && !connection?.accounts.includes(source.account) && <option value={source.account}>{source.account}</option>}</select></label></div>
        <div className="form-grid"><label>轮询间隔（秒）<input type="number" min={3} max={60} value={form.pollIntervalSeconds} onChange={(event) => setForm({ ...form, pollIntervalSeconds: Number(event.target.value) || 8 })} /></label><label className="toggle-row compact-toggle"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span><strong>启用微信助手收件</strong><small>仅接收已完成用户绑定后的新消息。</small></span></label></div>
        {connection && <InlineMessage tone="success">{connection.serverName} {connection.serverVersion} · MCP {connection.protocolVersion} · {connection.toolCount} 个工具</InlineMessage>}
        {source?.lastError && <InlineMessage tone="danger">最近接收失败：{source.lastError}</InlineMessage>}
        <div className="qr-config-row"><div><span className="qr-config-icon"><QrCode size={19} /></span><span><strong>助手二维码</strong><small>JPG、PNG 或 WebP；用户绑定时会在当前页面展示。</small></span></div><button type="button" className="button button-secondary qr-upload-button" onClick={() => qrInputRef.current?.click()}><Upload size={17} />{qrConfigured ? "更换二维码" : "上传二维码"}</button><input ref={qrInputRef} className="visually-hidden-file" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { void uploadQr(event.target.files?.[0]); event.currentTarget.value = ""; }} /></div>
        <div className="form-actions wechat-config-actions"><button className="button button-primary">保存连接配置</button><button type="button" className="button button-secondary" disabled={checking || !form.endpoint} onClick={() => void check()}><Activity size={17} />{checking ? "正在握手…" : "检查连接"}</button></div>
      </form>
    </div>)}
    <div className="section-caption wechat-binding-caption"><strong>用户绑定</strong><span>配置状态与用户绑定相互独立，只有已绑定联系人会进入对应账户。</span></div>
    <div className="wechat-assistant-bind">
      <div className="wechat-assistant-qr">{state.data?.source?.qrConfigured ? <img src={`/api/wechat-mcp/assistant-qr?v=${source?.updatedAt || "current"}`} alt="知流助手微信二维码" /> : <div className="qr-placeholder"><QrCode size={42} /><span>{owner.role === "admin" ? "请上传助手二维码" : "管理员尚未配置二维码"}</span></div>}</div>
      <div className="wechat-bind-copy"><strong>{binding ? `已绑定：${binding.wechatDisplayName}` : "添加助手并绑定账户"}</strong>{binding ? <><p>这个微信联系人发送给助手的新消息，会进入当前账户。最近收件：{binding.lastMessageAt ? formatDate(binding.lastMessageAt) : "尚无"}</p><button className="button button-secondary" onClick={() => void unbind()}>解除我的绑定</button></> : <><ol><li>使用微信扫描二维码，添加知流助手。</li><li>生成一次性绑定码，并原样发送给助手。</li><li>绑定成功后，再发送链接、文字或附件。</li></ol>{bindingCode ? <div className="binding-code"><div><span>15 分钟内有效</span><strong>{bindingCode.code}</strong><small>有效至 {formatDate(bindingCode.expiresAt)}</small></div><button className="button button-secondary" onClick={() => void navigator.clipboard.writeText(bindingCode.code)}><Copy size={16} />复制</button></div> : <button className="button button-primary" disabled={!state.data?.available} onClick={() => void generateCode()}><KeyRound size={17} />生成绑定码</button>}</>}</div>
    </div>
    {state.isError && <SettingsLoadError title="微信助手状态加载失败" error={state.error} onRetry={() => void state.refetch()} />}
    {owner.role === "admin" && !admin.isError && <div className="wechat-binding-overview">
      <div className="section-caption"><strong>全部用户绑定状态</strong><span>{boundUsers.length} 个已绑定 · {adminUsers.length - boundUsers.length} 个未绑定</span></div>
      {adminUsers.length > 5 && <label className="binding-search"><Search size={16} /><input value={bindingSearch} onChange={(event) => setBindingSearch(event.target.value)} placeholder="搜索用户名或微信联系人" aria-label="搜索微信助手绑定用户" /></label>}
      {visibleAdminUsers.length ? <div className="compact-list wechat-binding-list">
        {visibleAdminUsers.map((item) => {
          const routeMismatch = Boolean(item.binding && source?.account && item.binding.account && item.binding.account !== source.account);
          return <div key={item.tenantId}>
            <UserRound size={18} />
            <div><strong>{item.userDisplayName || item.username}<small>@{item.username}</small></strong><span>{item.binding ? `微信联系人：${item.binding.wechatDisplayName} · 绑定于 ${formatDate(item.binding.boundAt)}${item.binding.lastMessageAt ? ` · 最近收件 ${formatDate(item.binding.lastMessageAt)}` : " · 尚无收件"}` : "尚未绑定微信联系人"}</span></div>
            <span className={`status-badge ${item.disabled || routeMismatch ? "warning" : item.binding ? "success" : ""}`}>{item.disabled ? "账户已停用" : routeMismatch ? "需重新绑定" : item.binding ? "已绑定" : "未绑定"}</span>
            {item.binding && <button className="icon-button danger-text" onClick={() => void unbind(item.binding?.id)} aria-label={`解除 ${item.userDisplayName || item.username} 的微信绑定`}><Trash2 size={17} /></button>}
          </div>;
        })}
      </div> : <EmptyState title={admin.isLoading ? "正在读取用户状态" : "没有匹配用户"} description={admin.isLoading ? "绑定状态将在加载完成后显示。" : "请更换用户名或微信联系人关键词。"} />}
    </div>}
  </section>;
}

function ApiSettings() {
  const { notify } = useApp(); const queryClient = useQueryClient(); const [created, setCreated] = useState<ApiToken | null>(null);
  const tokens = useQuery({ queryKey: ["api-tokens"], queryFn: () => api<{ tokens: ApiToken[] }>("/api/me/api-tokens") });
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const value = await api<ApiToken>("/api/me/api-tokens", { method: "POST", body: JSON.stringify({ name: form.get("name") }) });
      setCreated(value);
      formElement.reset();
      notify("API 令牌已创建", "success");
      void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "API 令牌创建失败", "danger");
    }
  }
  async function revoke(id: string) {
    try {
      await api(`/api/me/api-tokens/${id}`, { method: "DELETE" });
      notify("API 令牌已撤销", "success");
      void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "API 令牌撤销失败", "danger");
    }
  }
  const activeTokens = tokens.data?.tokens.filter((item) => !item.revoked) || [];
  return <section className="settings-card"><div className="settings-card-title"><KeyRound size={19} /><div><h3>开放 API</h3><p>为浏览器扩展、快捷指令或自动化工具创建独立令牌。</p></div><span className="status-badge">{activeTokens.length} 个有效令牌</span></div>{tokens.isError ? <SettingsLoadError title="API 令牌加载失败" error={tokens.error} onRetry={() => void tokens.refetch()} /> : <>{created?.token && <div className="secret-reveal"><KeyRound size={20} /><div><strong>新 API 令牌</strong><code>{created.token}</code><small>只显示一次，请立即保存。</small></div><button className="button button-secondary" onClick={() => void navigator.clipboard.writeText(created.token || "")}><Copy size={17} />复制</button></div>}<div className="section-caption source-section-caption"><strong>创建收件令牌</strong><span>不同设备建议使用独立令牌，便于单独撤销。</span></div><form className="inline-create-form" onSubmit={(event) => void create(event)}><label>令牌名称<input name="name" required placeholder="例如：iPhone 快捷指令" /></label><button className="button button-primary"><Plus size={17} />创建令牌</button></form><div className="section-caption source-section-caption"><strong>令牌状态</strong><span>{tokens.isLoading ? "正在读取令牌" : activeTokens.length ? "最近使用时间会自动更新" : "尚未创建可用令牌"}</span></div>{tokens.isLoading ? <LoadingState label="正在读取 API 令牌" /> : <div className="compact-list">{activeTokens.map((token) => <div key={token.id}><div><strong>{token.name}</strong><span>创建于 {formatDate(token.createdAt)}{token.lastUsedAt ? ` · 最近使用 ${formatDate(token.lastUsedAt)}` : " · 尚未使用"}</span></div><button className="icon-button danger-text" onClick={() => void revoke(token.id)} aria-label={`撤销令牌 ${token.name}`}><Trash2 size={18} /></button></div>)}</div>}<div className="api-example"><h4>提交方式</h4><p>向 <code>POST /api/captures</code> 发送 JSON，并在 Authorization 中使用 Bearer 令牌。支持 <code>text</code>、<code>url</code> 与 <code>externalId</code>。</p></div></>}</section>;
}

function AiSettings() {
  const { owner, notify } = useApp();
  const queryClient = useQueryClient();
  const agent = useQuery({ queryKey: ["agent-settings"], queryFn: () => api<AgentSettings>("/api/agent/settings") });
  const provider = useQuery({ queryKey: ["provider-settings"], queryFn: () => api<ProviderSettings>("/api/nanobot/provider"), enabled: owner.role === "admin" });
  const [form, setForm] = useState({ provider: "", model: "", apiBase: "", apiKey: "" });
  const [catalog, setCatalog] = useState<ProviderModelCatalog | null>(null);
  const [connection, setConnection] = useState<ModelConnectionResult | DraftModelConnectionResult | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  useEffect(() => {
    if (!provider.data) return;
    setForm({ provider: provider.data.active.provider, model: provider.data.active.model, apiBase: provider.data.active.apiBase, apiKey: "" });
  }, [provider.data]);

  const selected = provider.data?.providers.find((item) => item.id === form.provider);
  const configuredProvider = provider.data?.active.provider === form.provider
    && (provider.data.active.apiKeyConfigured || selected?.auth !== "api_key");

  async function persistProvider(showNotice = true) {
    setSavingProvider(true);
    try {
      const result = await api<{ ok: boolean; autoReload?: boolean }>("/api/nanobot/provider", { method: "PUT", body: JSON.stringify(form) });
      await queryClient.invalidateQueries({ queryKey: ["provider-settings"] });
      if (showNotice) notify(result.autoReload === false ? "模型配置已保存，重启 Nanobot 后生效" : "模型配置已保存并正在加载", "success");
      return result;
    } finally {
      setSavingProvider(false);
    }
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConnection(null);
    try {
      await persistProvider();
    } catch (error) {
      notify(error instanceof Error ? error.message : "模型配置保存失败", "danger");
    }
  }

  async function connectOAuth() {
    try {
      await api("/api/nanobot/provider/openai-oauth", { method: "POST", body: JSON.stringify({ model: form.model }) });
      notify("OpenAI 账户授权已完成", "success");
      await queryClient.invalidateQueries({ queryKey: ["provider-settings"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "OpenAI 授权失败", "danger");
    }
  }

  async function refreshModels() {
    if (!form.provider) return;
    setLoadingCatalog(true);
    try {
      const value = await api<ProviderModelCatalog>(`/api/nanobot/provider/models?provider=${encodeURIComponent(form.provider)}`);
      setCatalog(value);
      if (value.status === "available") notify(`已从 Nanobot 获取 ${value.modelCount} 个可用模型`, "success");
      else notify(value.message || "当前服务没有提供在线模型列表，可手动填写模型 ID", "danger");
    } catch (error) {
      setCatalog(null);
      notify(error instanceof Error ? error.message : "模型列表获取失败", "danger");
    } finally {
      setLoadingCatalog(false);
    }
  }

  async function testProvider() {
    setConnection(null);
    setCheckingConnection(true);
    try {
      const result = selected?.auth === "oauth"
        ? await api<ModelConnectionResult>("/api/agent/test", { method: "POST" })
        : await api<DraftModelConnectionResult>("/api/nanobot/provider/test", {
          method: "POST",
          body: JSON.stringify(form),
        });
      setConnection(result);
      if (result.ok) notify(`${result.provider} / ${result.model} 文本调用正常；确认后可保存启用`, "success");
      else notify(result.error || "模型连接检查失败", "danger");
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接检查失败";
      setConnection({
        ok: false,
        stage: "network",
        elapsedMs: 0,
        provider: form.provider,
        model: form.model,
        usedSavedCredential: false,
        capabilities: { protocol: form.provider === "anthropic" ? "anthropic-messages" : "openai-chat-completions", endpointReachable: false, authentication: false, textCompletion: false },
        error: message,
      });
      notify(message, "danger");
    } finally {
      setCheckingConnection(false);
    }
  }

  async function saveAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/agent/settings", { method: "PUT", body: JSON.stringify({ enabled: data.get("enabled") === "on", baseUrl: agent.data?.baseUrl, instructions: data.get("instructions"), autoReply: false, notifyOnFailure: data.get("notifyOnFailure") === "on" }) });
      notify("智能整理设置已保存", "success");
      void queryClient.invalidateQueries({ queryKey: ["agent-settings"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "智能整理设置保存失败", "danger");
    }
  }

  return <>
    <SettingsHeader title="AI 智能整理" description="配置 Nanobot 使用的模型服务，以及新内容的自动整理方式。" />
    {owner.role === "admin" && <section className="settings-card">
      <div className="settings-card-title"><Settings2 size={19} /><div><h3>模型服务</h3><p>由 Nanobot 负责 Provider 协议、模型调用和工具执行；知流负责配置、检查与整理结果校验。</p></div></div>
      {provider.isLoading ? <LoadingState /> : provider.isError ? <SettingsLoadError title="模型服务配置加载失败" error={provider.error} onRetry={() => void provider.refetch()} /> : <form className="settings-form" onSubmit={selected?.auth === "oauth" ? (event) => { event.preventDefault(); void connectOAuth(); } : (event) => void saveProvider(event)}>
        <div className="form-grid">
          <label>服务提供商<select value={form.provider} onChange={(event) => { const next = provider.data?.providers.find((item) => item.id === event.target.value); setForm({ provider: event.target.value, model: next?.defaultModel || "", apiBase: next?.defaultBaseUrl || "", apiKey: "" }); setCatalog(null); setConnection(null); }}>{provider.data?.providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label>模型<input list="nanobot-provider-models" value={form.model} onChange={(event) => { setForm({ ...form, model: event.target.value }); setConnection(null); }} placeholder="填写或从在线列表选择模型 ID" /><datalist id="nanobot-provider-models">{catalog?.models.map((item) => <option value={item.id} key={item.id}>{item.label || item.description || item.ownedBy || item.id}</option>)}</datalist></label>
        </div>
        {selected?.auth !== "oauth" && <label>API 地址<input value={form.apiBase} onChange={(event) => { setForm({ ...form, apiBase: event.target.value }); setConnection(null); }} /></label>}
        {(selected?.auth === "api_key" || selected?.auth === "optional_key") && <label>API Key{selected.auth === "optional_key" ? "（可选）" : ""}<input type="password" value={form.apiKey} onChange={(event) => { setForm({ ...form, apiKey: event.target.value }); setConnection(null); }} placeholder={provider.data?.active.apiKeyConfigured && provider.data.active.provider === form.provider && selected.auth === "api_key" ? "已配置，留空保持不变" : selected.auth === "optional_key" ? "接口无需鉴权时可留空" : "输入 API Key"} /></label>}
        {selected?.auth !== "oauth" && <div className="model-catalog-bar"><div><strong>{catalog?.status === "available" ? `在线模型 · ${catalog.modelCount} 个` : configuredProvider ? "可刷新在线模型列表" : "保存配置后可读取在线模型"}</strong><small>{catalog?.status === "available" ? `目录由 Nanobot 获取 · ${new Date(catalog.fetchedAt * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : catalog?.message || "不提供模型目录的服务仍可手动填写准确的模型 ID。"}</small></div><button type="button" className="button button-secondary" disabled={loadingCatalog || !configuredProvider} onClick={() => void refreshModels()}><RefreshCw className={loadingCatalog ? "spin" : ""} size={17} />{loadingCatalog ? "刷新中…" : "刷新模型列表"}</button></div>}
        {connection && <InlineMessage tone={connection.ok ? "success" : "danger"}>{isDraftConnection(connection)
          ? connection.ok
            ? `${connection.provider} / ${connection.model} 已通过真实文本调用（${connection.elapsedMs} ms）· ${connection.capabilities.protocol === "anthropic-messages" ? "Anthropic Messages" : "OpenAI Chat Completions"} 兼容${connection.usedSavedCredential ? " · 使用当前已保存密钥" : " · 使用本次草稿密钥"}。配置尚未保存。`
            : `${connection.stage === "configuration" ? "配置" : connection.stage === "authentication" ? "身份验证" : connection.stage === "network" ? "网络或地址" : "模型响应"}检查失败：${connection.error || "未知错误"}${connection.suggestion ? `；${connection.suggestion}` : ""}`
          : connection.ok
            ? `${connection.provider} / ${connection.model} 可用；Runtime ${connection.runtimeMs ?? 0} ms，模型响应 ${connection.modelMs ?? 0} ms。`
            : `${connection.stage === "runtime" ? "Nanobot Runtime" : "模型服务"}检查失败：${connection.error || "未知错误"}`}</InlineMessage>}
        {selected?.auth !== "oauth" && <InlineMessage tone="default">检查连接只验证当前草稿，不会保存密钥、切换模型或影响正在运行的整理任务。验证通过后，请点击“保存并启用”。</InlineMessage>}
        <div className="form-actions">
          <button className="button button-primary" disabled={savingProvider || checkingConnection}>{selected?.auth === "oauth" ? "连接 OpenAI 账户" : savingProvider ? "保存中…" : "保存并启用"}</button>
          {selected?.auth !== "oauth" && <button type="button" className="button button-secondary" disabled={savingProvider || checkingConnection || !form.model.trim()} onClick={() => void testProvider()}><Activity size={17} />{checkingConnection ? "正在验证草稿…" : "检查草稿连接"}</button>}
          {selected?.auth === "oauth" && provider.data?.active.provider === "openai_codex" && <button type="button" className="button button-secondary" disabled={checkingConnection} onClick={() => void testProvider()}><Activity size={17} />{checkingConnection ? "正在检查…" : "检查连接"}</button>}
        </div>
      </form>}
    </section>}
    <section className="settings-card"><div className="settings-card-title"><SlidersHorizontal size={19} /><div><h3>整理方式</h3><p>控制收到新内容后是否自动生成分类、摘要和笔记。</p></div></div>{agent.isLoading ? <LoadingState /> : agent.isError ? <SettingsLoadError title="整理方式加载失败" error={agent.error} onRetry={() => void agent.refetch()} /> : <form className="settings-form" onSubmit={(event) => void saveAgent(event)}><label className="toggle-row"><input type="checkbox" name="enabled" defaultChecked={agent.data?.enabled} /><span><strong>启用智能整理</strong><small>关闭后仍会保留原始内容并支持同步。</small></span></label><label>我的整理偏好<textarea name="instructions" defaultValue={agent.data?.instructions} rows={5} placeholder="例如：文章先总结核心观点；有明确日期时提取为待办。" /></label><label className="toggle-row"><input type="checkbox" name="notifyOnFailure" defaultChecked={agent.data?.notifyOnFailure} /><span><strong>处理失败时提醒</strong><small>提醒会区分模型限流、结果格式、网页提取和任务停滞，不再统一显示为连接超时。</small></span></label><div className="form-actions"><button className="button button-primary">保存整理设置</button></div></form>}</section>
  </>;
}

function SkillsSettings() {
  const { owner, notify } = useApp();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => api<{ skills: ManagedSkill[] }>("/api/skills") });
  const rows = skills.data?.skills || [];
  const promptSkills = rows.filter((skill) => skill.kind === "prompt");
  const adapterSkills = rows.filter((skill) => skill.kind === "adapter");

  async function toggle(skill: ManagedSkill) {
    if (skill.kind === "adapter" && owner.role !== "admin") {
      notify("解析适配器由管理员统一管理", "danger");
      return;
    }
    try {
      await api(`/api/skills/${skill.id}`, { method: "PUT", body: JSON.stringify({ ...skill, enabled: !skill.enabled }) });
      notify(`${skill.name}已${skill.enabled ? "停用" : "启用"}`, "success");
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "Skill 状态更新失败", "danger");
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/skills", { method: "POST", body: JSON.stringify({ slug: form.get("slug"), name: form.get("name"), description: form.get("description"), content: form.get("content") }) });
      event.currentTarget.reset(); setCreating(false); notify("自定义 Skill 已创建", "success");
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    } catch (error) { notify(error instanceof Error ? error.message : "Skill 创建失败", "danger"); }
  }
  async function remove(skill: ManagedSkill) {
    if (!await confirm({ title: "删除自定义 Skill？", description: `“${skill.name}”将不再参与后续内容整理，已经生成的内容不会改变。`, confirmLabel: "删除 Skill", tone: "danger" })) return;
    try {
      await api(`/api/skills/${skill.id}`, { method: "DELETE" });
      notify("自定义 Skill 已删除", "success");
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "Skill 删除失败", "danger");
    }
  }
  function routeLabel(skill: ManagedSkill) {
    if (["inbox-router", "obsidian-note-builder"].includes(skill.slug)) return "基础规则 · 自动应用";
    return skill.kind === "adapter" ? "来源或意图触发" : "内容特征触发";
  }
  const group = (title: string, description: string, list: ManagedSkill[]) => <section className="skill-section"><div className="skill-section-heading"><div><h3>{title}</h3><p>{description}</p></div><span>{list.filter((skill) => skill.enabled).length}/{list.length} 已启用</span></div><div className="skills-grid">{list.map((skill) => { const adapterLocked = skill.kind === "adapter" && owner.role !== "admin"; return <article className="settings-card skill-card" key={skill.id}><div className="skill-icon">{skill.kind === "adapter" ? <Route size={20} /> : <Wrench size={20} />}</div><div className="skill-copy"><div className="skill-title"><h3>{skill.name}</h3><span className="skill-route-badge">{routeLabel(skill)}</span></div><p>{skill.description}</p><div className="skill-meta"><span>{skill.builtin ? "知流内置" : "自定义规则"}</span>{adapterLocked && <span>由管理员管理</span>}{skill.sourceUrl && <a href={skill.sourceUrl} target="_blank" rel="noreferrer">查看来源 <ExternalLink size={12} /></a>}</div></div><div className="skill-actions">{!skill.builtin && <button className="icon-button danger-text" type="button" onClick={() => void remove(skill)} aria-label={`删除${skill.name}`}><Trash2 size={16} /></button>}<button className={`toggle-button ${skill.enabled ? "on" : ""}`} disabled={adapterLocked} title={adapterLocked ? "解析适配器由管理员统一管理" : undefined} onClick={() => void toggle(skill)} aria-label={`${skill.enabled ? "停用" : "启用"}${skill.name}`}><i /></button></div></article>; })}</div></section>;

  return <><SettingsHeader title="整理能力" description="系统先按来源、内容形态和用户意图缩小候选范围，再由 Nanobot 使用最匹配的 Skill；专用解析优先，失败后才使用通用回退。" />
    <section className="settings-card skill-routing-card"><div className="settings-card-title"><Route size={19} /><div><h3>分层路由</h3><p>基础规则始终参与；文档、媒体和专业领域按内容触发；微信、网页与图解工具按来源或明确意图触发。没有足够证据时不猜测。</p></div></div><ol><li><strong>预筛选</strong><span>来源、附件形态与明确意图</span></li><li><strong>选择能力</strong><span>只向模型提供少量相关 Skill</span></li><li><strong>校验结果</strong><span>格式、证据与数据质量检查</span></li></ol></section>
    <div className="skill-create-bar"><div><strong>自定义整理规则</strong><span>为自己的专业内容增加明确的触发与跳过条件。</span></div><button className="button button-primary" type="button" onClick={() => setCreating((value) => !value)}><Plus size={17} />{creating ? "收起" : "新建 Skill"}</button></div>
    {creating && <section className="settings-card"><form className="settings-form skill-create-form" onSubmit={(event) => void create(event)}><div className="form-grid"><label>名称<input name="name" required maxLength={80} placeholder="例如：产品研究资料整理" /></label><label>标识<input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,59}" placeholder="product-research" /></label></div><label>路由说明<textarea name="description" rows={3} required maxLength={500} placeholder="TRIGGER：什么内容应使用。SKIP：什么情况不能使用。ROUTE：与其他 Skill 重叠时谁优先。" /></label><label>整理规则<textarea name="content" rows={8} required maxLength={20000} placeholder="说明要提取什么、证据要求、输出边界和失败时如何处理。" /></label><div className="form-actions"><button className="button button-primary">创建并启用</button></div></form></section>}
    {skills.isLoading ? <LoadingState /> : skills.isError ? <SettingsLoadError title="整理能力加载失败" error={skills.error} onRetry={() => void skills.refetch()} /> : <>{group("语义整理规则", "参与标题、分类、摘要、知识点和专业领域判断。", promptSkills)}{group("解析与可视化适配器", "由确定性路由选择；同一任务只启用必要的专用能力。", adapterSkills)}</>}
  </>;
}

function UsersSettings() {
  const { owner, notify } = useApp();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [createdInvitation, setCreatedInvitation] = useState<CreatedInvitation | null>(null);
  const [invitationStatusFilter, setInvitationStatusFilter] = useState("all");
  const [invitationPage, setInvitationPage] = useState(0);
  const [resetTarget, setResetTarget] = useState<Owner | null>(null);
  const resetTriggerRef = useRef<HTMLButtonElement | null>(null);
  const invitationPageSize = 8;
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api<{ users: (Owner & { botCount: number; messageCount: number })[] }>("/api/admin/users"),
  });
  const invitations = useQuery({
    queryKey: ["invitations", invitationStatusFilter, invitationPage],
    queryFn: () => {
      const params = new URLSearchParams({
        limit: String(invitationPageSize),
        offset: String(invitationPage * invitationPageSize),
        status: invitationStatusFilter,
      });
      return api<{ invitations: Invitation[]; pagination: { total: number; limit: number; offset: number; hasMore: boolean } }>(`/api/admin/invitations?${params}`);
    },
  });
  const rows = users.data?.users.filter((user) =>
    [user.username, user.displayName].join(" ").toLowerCase().includes(search.toLowerCase()),
  ) || [];
  const invitationUrl = createdInvitation
    ? `${window.location.origin}/?invite=${encodeURIComponent(createdInvitation.token)}`
    : "";

  function closeResetDialog() {
    setResetTarget(null);
    window.requestAnimationFrame(() => resetTriggerRef.current?.focus());
  }

  useEffect(() => {
    if (!resetTarget) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeResetDialog();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [resetTarget]);

  async function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const invitation = await api<CreatedInvitation>("/api/admin/invitations", {
        method: "POST",
        body: JSON.stringify({ hours: Number(data.get("hours") || 72) }),
      });
      setCreatedInvitation(invitation);
      notify("邀请链接已创建，请复制后发送给受邀用户", "success");
      void queryClient.invalidateQueries({ queryKey: ["invitations"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "邀请创建失败", "danger");
    }
  }

  async function copyInvitation(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(`${label}已复制`, "success");
    } catch {
      notify(`${label}复制失败，请手动选择复制`, "danger");
    }
  }

  async function revokeInvitation(invitation: Invitation) {
    if (!await confirm({ title: "撤销这个邀请码？", description: "撤销后该邀请码会立即失效，已使用该邀请创建的账户不受影响。", confirmLabel: "撤销邀请", tone: "danger" })) return;
    try {
      await api(`/api/admin/invitations/${invitation.id}`, { method: "DELETE" });
      notify("邀请码已撤销", "success");
      void queryClient.invalidateQueries({ queryKey: ["invitations"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "邀请码撤销失败", "danger");
    }
  }

  function invitationStatus(invitation: Invitation) {
    if (invitation.consumed) return { label: "已使用", tone: "success" };
    if (invitation.revoked) return { label: "已撤销", tone: "danger" };
    if (new Date(invitation.expiresAt).getTime() <= Date.now()) return { label: "已过期", tone: "danger" };
    return { label: "待使用", tone: "processing" };
  }

  async function setDisabled(user: Owner) {
    try {
      await api(`/api/admin/users/${user.id}/status`, { method: "PUT", body: JSON.stringify({ disabled: !user.disabled }) });
      notify(`用户已${user.disabled ? "启用" : "停用"}`, "success");
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "用户状态更新失败", "danger");
    }
  }

  async function removeUser(user: Owner) {
    const accepted = await confirm({
      title: `永久删除 @${user.username}？`,
      description: "该用户的内容、附件、问答记录与同步配置都会被永久删除，无法恢复。",
      confirmLabel: "永久删除用户",
      tone: "danger",
      requireText: user.username,
    });
    if (!accepted) return;
    try {
      await api(`/api/admin/users/${user.id}`, { method: "DELETE", body: JSON.stringify({ confirmation: user.username }) });
      notify("用户及其工作区数据已删除", "success");
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "用户删除失败", "danger");
    }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetTarget) return;
    const data = new FormData(event.currentTarget);
    try {
      await api(`/api/admin/users/${resetTarget.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({
          newPassword: data.get("newPassword"),
          confirmPassword: data.get("confirmPassword"),
        }),
      });
      notify(`@${resetTarget.username} 的密码已重置，原有登录已失效`, "success");
      closeResetDialog();
    } catch (error) {
      notify(error instanceof Error ? error.message : "密码重置失败", "danger");
    }
  }

  return <>
    <SettingsHeader title="用户管理" description="通过一次性邀请码添加用户，并管理彼此隔离的个人知识工作区。" />
    <section className="settings-card">
      <div className="settings-card-title"><UserPlus size={19} /><div><h3>邀请用户</h3><p>每个邀请码仅可使用一次，到期或撤销后立即失效。</p></div></div>
      <form className="inline-create-form invitation-create" onSubmit={(event) => void createInvitation(event)}>
        <label>有效期<select name="hours" defaultValue="72"><option value="24">24 小时</option><option value="72">3 天</option><option value="168">7 天</option><option value="720">30 天</option></select></label>
        <button className="button button-primary"><Plus size={17} />创建邀请</button>
      </form>
      {createdInvitation && <div className="secret-reveal invitation-secret"><KeyRound size={20} /><div><strong>邀请链接（仅显示一次）</strong><code>{invitationUrl}</code><small>有效至 {formatDate(createdInvitation.expiresAt)}。受邀用户打开链接即可直接创建账户。</small></div><div className="secret-actions"><button className="button button-secondary" onClick={() => void copyInvitation(invitationUrl, "邀请链接")}><Copy size={16} />复制链接</button><button className="button button-secondary" onClick={() => void copyInvitation(createdInvitation.token, "邀请码")}><Copy size={16} />复制邀请码</button></div></div>}
      <div className="invitation-list-toolbar"><label>邀请记录<select value={invitationStatusFilter} onChange={(event) => { setInvitationStatusFilter(event.target.value); setInvitationPage(0); }}><option value="all">全部状态</option><option value="pending">待使用</option><option value="used">已使用</option><option value="expired">已过期</option><option value="revoked">已撤销</option></select></label><span>共 {invitations.data?.pagination.total || 0} 条</span></div>
      {invitations.isLoading ? <LoadingState /> : invitations.isError ? <SettingsLoadError title="邀请记录加载失败" error={invitations.error} onRetry={() => void invitations.refetch()} /> : invitations.data?.invitations.length ? <><div className="invitation-list">{invitations.data.invitations.map((invitation) => { const status = invitationStatus(invitation); const active = status.label === "待使用"; return <div key={invitation.id}><div><strong>{invitation.consumedBy ? `由 ${invitation.consumedBy.displayName} (@${invitation.consumedBy.username}) 使用` : "一次性用户邀请"}</strong><span>创建于 {formatDate(invitation.createdAt)} · 有效至 {formatDate(invitation.expiresAt)}</span></div><span className={`status-badge ${status.tone}`}>{status.label}</span>{active && <button type="button" className="button button-secondary" onClick={() => void revokeInvitation(invitation)}>撤销</button>}</div>; })}</div><div className="list-pagination"><button type="button" className="button button-secondary" disabled={invitationPage === 0} onClick={() => setInvitationPage((page) => Math.max(0, page - 1))}><ChevronLeft size={16} />上一页</button><span>第 {invitationPage + 1} 页</span><button type="button" className="button button-secondary" disabled={!invitations.data.pagination.hasMore} onClick={() => setInvitationPage((page) => page + 1)}>下一页<ChevronRight size={16} /></button></div></> : <EmptyState title={invitationStatusFilter === "all" ? "尚未创建邀请" : "这个状态下没有邀请记录"} description={invitationStatusFilter === "all" ? "创建后将生成一次性邀请链接。" : "可以切换状态查看其他邀请记录。"} />}
    </section>
    <section className="settings-card">
      <div className="settings-card-title"><UserRound size={19} /><div><h3>工作区用户</h3><p>搜索、重置密码、停用或永久删除已有用户。</p></div></div>
      {users.isError ? <SettingsLoadError title="用户列表加载失败" error={users.error} onRetry={() => void users.refetch()} /> : <><label className="table-search user-search">搜索用户<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="用户名或显示名称" /></label>{users.isLoading ? <LoadingState label="正在读取工作区用户" /> : rows.length ? <div className="user-table">{rows.map((user) => <div key={user.id}><span className="avatar">{user.displayName.slice(0, 1)}</span><div><strong>{user.displayName}</strong><small>@{user.username} · {user.messageCount} 条内容 · {user.botCount} 个微信账号</small></div><span className={`status-badge ${user.disabled ? "danger" : "success"}`}>{user.disabled ? "已停用" : user.role === "admin" ? "管理员" : "正常"}</span>{user.id !== owner.id && <div className="user-actions"><button type="button" className="button button-secondary" onClick={(event) => { resetTriggerRef.current = event.currentTarget; setResetTarget(user); }}><LockKeyhole size={16} />重置密码</button><button type="button" className="button button-secondary" onClick={() => void setDisabled(user)}>{user.disabled ? "启用" : "停用"}</button><button type="button" className="icon-button danger-text" aria-label={`删除用户 ${user.username}`} onClick={() => void removeUser(user)}><Trash2 size={18} /></button></div>}</div>)}</div> : <EmptyState title="没有匹配用户" description="请更换用户名或显示名称关键词。" />}</>}
    </section>
    {resetTarget && <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeResetDialog(); }}><section className="account-action-modal" role="dialog" aria-modal="true" aria-label="重置用户密码"><header><div><span className="eyebrow">ACCOUNT SECURITY</span><h2>重置用户密码</h2><p>为 {resetTarget.displayName}（@{resetTarget.username}）设置新密码。保存后，该用户在其他设备上的登录会立即失效。</p></div><button className="icon-button" type="button" aria-label="关闭" onClick={closeResetDialog}><X size={20} /></button></header><form className="settings-form" onSubmit={(event) => void resetPassword(event)}><label>新密码<input name="newPassword" type="password" minLength={8} required autoFocus autoComplete="new-password" /></label><label>再次输入新密码<input name="confirmPassword" type="password" minLength={8} required autoComplete="new-password" /></label><div className="form-actions"><button type="button" className="button button-secondary" onClick={closeResetDialog}>取消</button><button className="button button-primary"><LockKeyhole size={16} />确认重置</button></div></form></section></div>}
  </>;
}

function AccountSettings() {
  const { owner, setOwner, notify, logout } = useApp();
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  async function profile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSavingProfile(true);
    try {
      const result = await api<{ owner: Owner }>("/api/me/profile", { method: "PUT", body: JSON.stringify({ displayName: data.get("displayName") }) });
      setOwner(result.owner);
      notify("个人资料已更新", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "个人资料保存失败", "danger");
    } finally {
      setSavingProfile(false);
    }
  }
  async function password(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSavingPassword(true);
    try {
      await api("/api/me/password", { method: "POST", body: JSON.stringify({ currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword"), confirmPassword: data.get("confirmPassword") }) });
      notify("密码已更新，请重新登录", "success");
      await logout();
    } catch (error) {
      notify(error instanceof Error ? error.message : "密码更新失败", "danger");
    } finally {
      setSavingPassword(false);
    }
  }
  return <><SettingsHeader title="账号与安全" description="管理显示名称和登录密码。修改密码后，当前会话会立即退出。" /><section className="settings-card"><div className="settings-card-title"><UserRound size={19} /><div><h3>个人资料</h3><p>用户名 @{owner.username} 不可修改。</p></div></div><form className="settings-form" onSubmit={(event) => void profile(event)}><label>显示名称<input name="displayName" defaultValue={owner.displayName} /></label><div className="form-actions"><button className="button button-primary" disabled={savingProfile}>{savingProfile ? "保存中…" : "保存资料"}</button></div></form></section><section className="settings-card"><div className="settings-card-title"><Shield size={19} /><div><h3>修改密码</h3><p>新密码至少 8 个字符，并需要输入两次确认。</p></div></div><form className="settings-form" onSubmit={(event) => void password(event)}><label>当前密码<input name="currentPassword" type="password" required autoComplete="current-password" /></label><div className="form-grid"><label>新密码<input name="newPassword" type="password" minLength={8} required autoComplete="new-password" /></label><label>再次输入新密码<input name="confirmPassword" type="password" minLength={8} required autoComplete="new-password" /></label></div><div className="form-actions"><button className="button button-primary" disabled={savingPassword}>{savingPassword ? "更新中…" : "更新密码"}</button></div></form></section></>;
}
