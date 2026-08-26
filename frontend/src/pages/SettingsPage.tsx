import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, CheckCircle2, ChevronLeft, ChevronRight, Copy, ExternalLink, KeyRound, LockKeyhole, Plus, RefreshCw, Route, Settings2, Shield, SlidersHorizontal, Trash2, UserPlus, UserRound, Wrench, X } from "lucide-react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import type { AgentSettings, ApiToken, BotAccount, CreatedInvitation, Invitation, ManagedSkill, ModelConnectionResult, Owner, ProviderModelCatalog, ProviderSettings } from "../types";
import { useApp } from "../App";
import { EmptyState, InlineMessage, LoadingState, PageHeader, formatDate } from "../components/ui";

export default function SettingsPage() {
  const { section = "intake" } = useParams();
  const { owner } = useApp();
  const currentSection = ["sources", "api"].includes(section) ? "intake" : section;
  return <main className="page settings-page"><PageHeader eyebrow="SYSTEM SETTINGS" title="系统设置" description="管理收件接入、智能整理、用户与账户安全。" /><div className="settings-content">{currentSection === "intake" ? <IntakeSettings /> : currentSection === "ai" ? <AiSettings /> : currentSection === "skills" ? <SkillsSettings /> : currentSection === "users" && owner.role === "admin" ? <UsersSettings /> : <AccountSettings />}</div></main>;
}

function SettingsHeader({ title, description }: { title: string; description: string }) { return <div className="settings-heading"><h2>{title}</h2><p>{description}</p></div>; }

function IntakeSettings() {
  return <><SettingsHeader title="收件接入" description="通过微信 iLink 或开放 API 把链接、文字与附件汇入同一个收件台。" /><div className="intake-stack"><SourcesSettings /><ApiSettings /></div></>;
}

function SourcesSettings() {
  const { notify } = useApp(); const queryClient = useQueryClient();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api<{ accounts: BotAccount[] }>("/api/dashboard") });
  const [session, setSession] = useState<{ sessionId: string; qrUrl?: string } | null>(null);
  async function start() { const value = await api<{ sessionId: string }>("/api/ilink/login/start", { method: "POST" }); setSession({ sessionId: value.sessionId, qrUrl: `/api/ilink/login/${value.sessionId}/qr.svg` }); }
  async function disconnect(account: BotAccount) { if (!window.confirm("断开后将停止接收这个微信账号的新消息。确定继续吗？")) return; await api(`/api/ilink/accounts/${account.id}`, { method: "DELETE" }); notify("微信账号已断开", "success"); void queryClient.invalidateQueries({ queryKey: ["dashboard"] }); }
  useEffect(() => { if (!session) return; const timer = window.setInterval(async () => { try { const status = await api<{ status: string }>(`/api/ilink/login/${session.sessionId}/status`); if (["connected", "confirmed", "success"].includes(status.status)) { setSession(null); notify("微信 iLink 已连接", "success"); void queryClient.invalidateQueries({ queryKey: ["dashboard"] }); } } catch { /* login session may briefly rotate */ } }, 2500); return () => window.clearInterval(timer); }, [notify, queryClient, session]);
  return <section className="settings-card"><div className="settings-card-head"><div className="source-logo wechat">微</div><div><h3>微信 iLink</h3><p>把消息、公众号文章和附件发送给 iLink Bot。</p></div><button className="button button-primary" onClick={() => void start()}><Plus size={17} />连接微信</button></div>{session?.qrUrl && <div className="qr-connect"><img src={session.qrUrl} alt="微信 iLink 登录二维码" /><div><strong>使用微信扫码连接</strong><p>扫码后按微信提示完成确认，此页面会自动更新。</p></div></div>}{dashboard.isLoading ? <LoadingState /> : dashboard.data?.accounts.length ? <div className="source-list">{dashboard.data.accounts.map((account) => <div key={account.id}><CheckCircle2 size={19} /><div><strong>{account.botId}</strong><span>连接于 {formatDate(account.connectedAt)}</span></div><span className="status-badge success">已连接</span><button className="icon-button danger-text" aria-label="断开微信账号" onClick={() => void disconnect(account)}><Trash2 size={17} /></button></div>)}</div> : <EmptyState title="尚未连接微信" description="连接后即可通过微信发送内容。" />}</section>;
}

function ApiSettings() {
  const { notify } = useApp(); const queryClient = useQueryClient(); const [created, setCreated] = useState<ApiToken | null>(null);
  const tokens = useQuery({ queryKey: ["api-tokens"], queryFn: () => api<{ tokens: ApiToken[] }>("/api/me/api-tokens") });
  async function create(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); const value = await api<ApiToken>("/api/me/api-tokens", { method: "POST", body: JSON.stringify({ name: form.get("name") }) }); setCreated(value); event.currentTarget.reset(); void queryClient.invalidateQueries({ queryKey: ["api-tokens"] }); }
  async function revoke(id: string) { await api(`/api/me/api-tokens/${id}`, { method: "DELETE" }); notify("API 令牌已撤销", "success"); void queryClient.invalidateQueries({ queryKey: ["api-tokens"] }); }
  return <section className="settings-card"><div className="settings-card-title"><KeyRound size={19} /><div><h3>开放 API</h3><p>为浏览器扩展、快捷指令或自动化工具创建独立令牌。</p></div></div>{created?.token && <div className="secret-reveal"><KeyRound size={20} /><div><strong>新 API 令牌</strong><code>{created.token}</code><small>只显示一次，请立即保存。</small></div><button className="button button-secondary" onClick={() => void navigator.clipboard.writeText(created.token || "")}><Copy size={17} />复制</button></div>}<form className="inline-create-form" onSubmit={(event) => void create(event)}><label>令牌名称<input name="name" required placeholder="例如：iPhone 快捷指令" /></label><button className="button button-primary"><Plus size={17} />创建令牌</button></form><div className="compact-list">{tokens.data?.tokens.filter((item) => !item.revoked).map((token) => <div key={token.id}><div><strong>{token.name}</strong><span>创建于 {formatDate(token.createdAt)}{token.lastUsedAt ? ` · 最近使用 ${formatDate(token.lastUsedAt)}` : ""}</span></div><button className="icon-button danger-text" onClick={() => void revoke(token.id)} aria-label={`撤销令牌 ${token.name}`}><Trash2 size={18} /></button></div>)}</div><div className="api-example"><h4>提交方式</h4><p>向 <code>POST /api/captures</code> 发送 JSON，并在 Authorization 中使用 Bearer 令牌。支持 <code>text</code>、<code>url</code> 与 <code>externalId</code>。</p></div></section>;
}

function AiSettings() {
  const { owner, notify } = useApp();
  const queryClient = useQueryClient();
  const agent = useQuery({ queryKey: ["agent-settings"], queryFn: () => api<AgentSettings>("/api/agent/settings") });
  const provider = useQuery({ queryKey: ["provider-settings"], queryFn: () => api<ProviderSettings>("/api/nanobot/provider"), enabled: owner.role === "admin" });
  const [form, setForm] = useState({ provider: "", model: "", apiBase: "", apiKey: "" });
  const [catalog, setCatalog] = useState<ProviderModelCatalog | null>(null);
  const [connection, setConnection] = useState<ModelConnectionResult | null>(null);
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
      if (selected?.auth !== "oauth") {
        await persistProvider(false);
        await new Promise((resolve) => window.setTimeout(resolve, 900));
      }
      let result: ModelConnectionResult | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          result = await api<ModelConnectionResult>("/api/agent/test", { method: "POST" });
          if (result.ok || result.stage !== "runtime" || attempt === 2) break;
        } catch (error) {
          if (attempt === 2) throw error;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 900 + attempt * 600));
      }
      if (!result) throw new Error("没有收到连接检查结果");
      setConnection(result);
      if (result.ok) notify(`${result.provider} / ${result.model} 连接正常`, "success");
      else notify(result.error || "模型连接检查失败", "danger");
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接检查失败";
      setConnection({ ok: false, stage: "runtime", elapsedMs: 0, provider: form.provider, model: form.model, error: message });
      notify(message, "danger");
    } finally {
      setCheckingConnection(false);
    }
  }

  async function saveAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await api("/api/agent/settings", { method: "PUT", body: JSON.stringify({ enabled: data.get("enabled") === "on", baseUrl: agent.data?.baseUrl, instructions: data.get("instructions"), autoReply: false, notifyOnFailure: data.get("notifyOnFailure") === "on" }) });
    notify("智能整理设置已保存", "success");
    void queryClient.invalidateQueries({ queryKey: ["agent-settings"] });
  }

  return <>
    <SettingsHeader title="AI 智能整理" description="配置 Nanobot 使用的模型服务，以及新内容的自动整理方式。" />
    {owner.role === "admin" && <section className="settings-card">
      <div className="settings-card-title"><Settings2 size={19} /><div><h3>模型服务</h3><p>由 Nanobot 负责 Provider 协议、模型调用和工具执行；知流负责配置、检查与整理结果校验。</p></div></div>
      {provider.isLoading ? <LoadingState /> : <form className="settings-form" onSubmit={selected?.auth === "oauth" ? (event) => { event.preventDefault(); void connectOAuth(); } : (event) => void saveProvider(event)}>
        <div className="form-grid">
          <label>服务提供商<select value={form.provider} onChange={(event) => { const next = provider.data?.providers.find((item) => item.id === event.target.value); setForm({ provider: event.target.value, model: next?.defaultModel || "", apiBase: next?.defaultBaseUrl || "", apiKey: "" }); setCatalog(null); setConnection(null); }}>{provider.data?.providers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label>模型<input list="nanobot-provider-models" value={form.model} onChange={(event) => { setForm({ ...form, model: event.target.value }); setConnection(null); }} placeholder="填写或从在线列表选择模型 ID" /><datalist id="nanobot-provider-models">{catalog?.models.map((item) => <option value={item.id} key={item.id}>{item.label || item.description || item.ownedBy || item.id}</option>)}</datalist></label>
        </div>
        {selected?.auth !== "oauth" && <label>API 地址<input value={form.apiBase} onChange={(event) => { setForm({ ...form, apiBase: event.target.value }); setConnection(null); }} /></label>}
        {(selected?.auth === "api_key" || selected?.auth === "optional_key") && <label>API Key{selected.auth === "optional_key" ? "（可选）" : ""}<input type="password" value={form.apiKey} onChange={(event) => { setForm({ ...form, apiKey: event.target.value }); setConnection(null); }} placeholder={provider.data?.active.apiKeyConfigured && provider.data.active.provider === form.provider && selected.auth === "api_key" ? "已配置，留空保持不变" : selected.auth === "optional_key" ? "接口无需鉴权时可留空" : "输入 API Key"} /></label>}
        {selected?.auth !== "oauth" && <div className="model-catalog-bar"><div><strong>{catalog?.status === "available" ? `在线模型 · ${catalog.modelCount} 个` : configuredProvider ? "可刷新在线模型列表" : "保存配置后可读取在线模型"}</strong><small>{catalog?.status === "available" ? `目录由 Nanobot 获取 · ${new Date(catalog.fetchedAt * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : catalog?.message || "不提供模型目录的服务仍可手动填写准确的模型 ID。"}</small></div><button type="button" className="button button-secondary" disabled={loadingCatalog || !configuredProvider} onClick={() => void refreshModels()}><RefreshCw className={loadingCatalog ? "spin" : ""} size={17} />{loadingCatalog ? "刷新中…" : "刷新模型列表"}</button></div>}
        {connection && <InlineMessage tone={connection.ok ? "success" : "danger"}>{connection.ok ? `${connection.provider} / ${connection.model} 可用；Runtime ${connection.runtimeMs ?? 0} ms，模型响应 ${connection.modelMs ?? 0} ms。` : `${connection.stage === "runtime" ? "Nanobot Runtime" : "模型服务"}检查失败：${connection.error || "未知错误"}`}</InlineMessage>}
        <div className="form-actions">
          <button className="button button-primary" disabled={savingProvider || checkingConnection}>{selected?.auth === "oauth" ? "连接 OpenAI 账户" : savingProvider ? "保存中…" : "保存模型配置"}</button>
          {selected?.auth !== "oauth" && <button type="button" className="button button-secondary" disabled={savingProvider || checkingConnection || !form.model.trim()} onClick={() => void testProvider()}><Activity size={17} />{checkingConnection ? "正在检查真实调用…" : "保存并检查连接"}</button>}
          {selected?.auth === "oauth" && provider.data?.active.provider === "openai_codex" && <button type="button" className="button button-secondary" disabled={checkingConnection} onClick={() => void testProvider()}><Activity size={17} />{checkingConnection ? "正在检查…" : "检查连接"}</button>}
        </div>
      </form>}
    </section>}
    <section className="settings-card"><div className="settings-card-title"><SlidersHorizontal size={19} /><div><h3>整理方式</h3><p>控制收到新内容后是否自动生成分类、摘要和笔记。</p></div></div>{agent.isLoading ? <LoadingState /> : <form className="settings-form" onSubmit={(event) => void saveAgent(event)}><label className="toggle-row"><input type="checkbox" name="enabled" defaultChecked={agent.data?.enabled} /><span><strong>启用智能整理</strong><small>关闭后仍会保留原始内容并支持同步。</small></span></label><label>我的整理偏好<textarea name="instructions" defaultValue={agent.data?.instructions} rows={5} placeholder="例如：文章先总结核心观点；有明确日期时提取为待办。" /></label><label className="toggle-row"><input type="checkbox" name="notifyOnFailure" defaultChecked={agent.data?.notifyOnFailure} /><span><strong>处理失败时提醒</strong><small>提醒会区分模型限流、结果格式、网页提取和任务停滞，不再统一显示为连接超时。</small></span></label><div className="form-actions"><button className="button button-primary">保存整理设置</button></div></form>}</section>
  </>;
}

function SkillsSettings() {
  const { notify } = useApp();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => api<{ skills: ManagedSkill[] }>("/api/skills") });
  const rows = skills.data?.skills || [];
  const promptSkills = rows.filter((skill) => skill.kind === "prompt");
  const adapterSkills = rows.filter((skill) => skill.kind === "adapter");

  async function toggle(skill: ManagedSkill) {
    await api(`/api/skills/${skill.id}`, { method: "PUT", body: JSON.stringify({ ...skill, enabled: !skill.enabled }) });
    notify(`${skill.name}已${skill.enabled ? "停用" : "启用"}`, "success");
    void queryClient.invalidateQueries({ queryKey: ["skills"] });
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
    if (!window.confirm(`删除自定义 Skill“${skill.name}”？`)) return;
    await api(`/api/skills/${skill.id}`, { method: "DELETE" });
    notify("自定义 Skill 已删除", "success");
    void queryClient.invalidateQueries({ queryKey: ["skills"] });
  }
  function routeLabel(skill: ManagedSkill) {
    if (["inbox-router", "obsidian-note-builder"].includes(skill.slug)) return "基础规则 · 自动应用";
    return skill.kind === "adapter" ? "来源或意图触发" : "内容特征触发";
  }
  const group = (title: string, description: string, list: ManagedSkill[]) => <section className="skill-section"><div className="skill-section-heading"><div><h3>{title}</h3><p>{description}</p></div><span>{list.filter((skill) => skill.enabled).length}/{list.length} 已启用</span></div><div className="skills-grid">{list.map((skill) => <article className="settings-card skill-card" key={skill.id}><div className="skill-icon">{skill.kind === "adapter" ? <Route size={20} /> : <Wrench size={20} />}</div><div className="skill-copy"><div className="skill-title"><h3>{skill.name}</h3><span className="skill-route-badge">{routeLabel(skill)}</span></div><p>{skill.description}</p><div className="skill-meta"><span>{skill.builtin ? "知流内置" : "自定义规则"}</span>{skill.sourceUrl && <a href={skill.sourceUrl} target="_blank" rel="noreferrer">查看来源 <ExternalLink size={12} /></a>}</div></div><div className="skill-actions">{!skill.builtin && <button className="icon-button danger-text" type="button" onClick={() => void remove(skill)} aria-label={`删除${skill.name}`}><Trash2 size={16} /></button>}<button className={`toggle-button ${skill.enabled ? "on" : ""}`} onClick={() => void toggle(skill)} aria-label={`${skill.enabled ? "停用" : "启用"}${skill.name}`}><i /></button></div></article>)}</div></section>;

  return <><SettingsHeader title="整理能力" description="系统先按来源、内容形态和用户意图缩小候选范围，再由 Nanobot 使用最匹配的 Skill；专用解析优先，失败后才使用通用回退。" />
    <section className="settings-card skill-routing-card"><div className="settings-card-title"><Route size={19} /><div><h3>分层路由</h3><p>基础规则始终参与；文档、媒体和专业领域按内容触发；微信、网页与图解工具按来源或明确意图触发。没有足够证据时不猜测。</p></div></div><ol><li><strong>预筛选</strong><span>来源、附件形态与明确意图</span></li><li><strong>选择能力</strong><span>只向模型提供少量相关 Skill</span></li><li><strong>校验结果</strong><span>格式、证据与数据质量检查</span></li></ol></section>
    <div className="skill-create-bar"><div><strong>自定义整理规则</strong><span>为自己的专业内容增加明确的触发与跳过条件。</span></div><button className="button button-primary" type="button" onClick={() => setCreating((value) => !value)}><Plus size={17} />{creating ? "收起" : "新建 Skill"}</button></div>
    {creating && <section className="settings-card"><form className="settings-form skill-create-form" onSubmit={(event) => void create(event)}><div className="form-grid"><label>名称<input name="name" required maxLength={80} placeholder="例如：产品研究资料整理" /></label><label>标识<input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,59}" placeholder="product-research" /></label></div><label>路由说明<textarea name="description" rows={3} required maxLength={500} placeholder="TRIGGER：什么内容应使用。SKIP：什么情况不能使用。ROUTE：与其他 Skill 重叠时谁优先。" /></label><label>整理规则<textarea name="content" rows={8} required maxLength={20000} placeholder="说明要提取什么、证据要求、输出边界和失败时如何处理。" /></label><div className="form-actions"><button className="button button-primary">创建并启用</button></div></form></section>}
    {skills.isLoading ? <LoadingState /> : <>{group("语义整理规则", "参与标题、分类、摘要、知识点和专业领域判断。", promptSkills)}{group("解析与可视化适配器", "由确定性路由选择；同一任务只启用必要的专用能力。", adapterSkills)}</>}
  </>;
}

function UsersSettings() {
  const { owner, notify } = useApp();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [createdInvitation, setCreatedInvitation] = useState<CreatedInvitation | null>(null);
  const [invitationStatusFilter, setInvitationStatusFilter] = useState("all");
  const [invitationPage, setInvitationPage] = useState(0);
  const [resetTarget, setResetTarget] = useState<Owner | null>(null);
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
    if (!window.confirm("撤销后，此邀请码将无法继续注册。确定撤销吗？")) return;
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
    await api(`/api/admin/users/${user.id}/status`, { method: "PUT", body: JSON.stringify({ disabled: !user.disabled }) });
    notify(`用户已${user.disabled ? "启用" : "停用"}`, "success");
    void queryClient.invalidateQueries({ queryKey: ["users"] });
  }

  async function removeUser(user: Owner) {
    const confirmation = window.prompt(`永久删除 @${user.username} 及其所有内容、附件和同步配置。请输入完整用户名确认：`);
    if (confirmation !== user.username) return;
    await api(`/api/admin/users/${user.id}`, { method: "DELETE", body: JSON.stringify({ confirmation }) });
    notify("用户及其工作区数据已删除", "success");
    void queryClient.invalidateQueries({ queryKey: ["users"] });
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
      setResetTarget(null);
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
      {invitations.isLoading ? <LoadingState /> : invitations.data?.invitations.length ? <><div className="invitation-list">{invitations.data.invitations.map((invitation) => { const status = invitationStatus(invitation); const active = status.label === "待使用"; return <div key={invitation.id}><div><strong>{invitation.consumedBy ? `由 ${invitation.consumedBy.displayName} (@${invitation.consumedBy.username}) 使用` : "一次性用户邀请"}</strong><span>创建于 {formatDate(invitation.createdAt)} · 有效至 {formatDate(invitation.expiresAt)}</span></div><span className={`status-badge ${status.tone}`}>{status.label}</span>{active && <button className="button button-secondary" onClick={() => void revokeInvitation(invitation)}>撤销</button>}</div>; })}</div><div className="list-pagination"><button className="button button-secondary" disabled={invitationPage === 0} onClick={() => setInvitationPage((page) => Math.max(0, page - 1))}><ChevronLeft size={16} />上一页</button><span>第 {invitationPage + 1} 页</span><button className="button button-secondary" disabled={!invitations.data.pagination.hasMore} onClick={() => setInvitationPage((page) => page + 1)}>下一页<ChevronRight size={16} /></button></div></> : <EmptyState title={invitationStatusFilter === "all" ? "尚未创建邀请" : "这个状态下没有邀请记录"} description={invitationStatusFilter === "all" ? "创建后将生成一次性邀请链接。" : "可以切换状态查看其他邀请记录。"} />}
    </section>
    <section className="settings-card">
      <div className="settings-card-title"><UserRound size={19} /><div><h3>工作区用户</h3><p>搜索、重置密码、停用或永久删除已有用户。</p></div></div>
      <label className="table-search user-search">搜索用户<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="用户名或显示名称" /></label>
      <div className="user-table">{rows.map((user) => <div key={user.id}><span className="avatar">{user.displayName.slice(0, 1)}</span><div><strong>{user.displayName}</strong><small>@{user.username} · {user.messageCount} 条内容 · {user.botCount} 个微信账号</small></div><span className={`status-badge ${user.disabled ? "danger" : "success"}`}>{user.disabled ? "已停用" : user.role === "admin" ? "管理员" : "正常"}</span>{user.id !== owner.id && <div className="user-actions"><button className="button button-secondary" onClick={() => setResetTarget(user)}><LockKeyhole size={16} />重置密码</button><button className="button button-secondary" onClick={() => void setDisabled(user)}>{user.disabled ? "启用" : "停用"}</button><button className="icon-button danger-text" aria-label={`删除用户 ${user.username}`} onClick={() => void removeUser(user)}><Trash2 size={18} /></button></div>}</div>)}</div>
    </section>
    {resetTarget && <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setResetTarget(null); }}><section className="account-action-modal" role="dialog" aria-modal="true" aria-label="重置用户密码"><header><div><span className="eyebrow">ACCOUNT SECURITY</span><h2>重置用户密码</h2><p>为 {resetTarget.displayName}（@{resetTarget.username}）设置新密码。保存后，该用户在其他设备上的登录会立即失效。</p></div><button className="icon-button" aria-label="关闭" onClick={() => setResetTarget(null)}><X size={20} /></button></header><form className="settings-form" onSubmit={(event) => void resetPassword(event)}><label>新密码<input name="newPassword" type="password" minLength={8} required autoFocus autoComplete="new-password" /></label><label>再次输入新密码<input name="confirmPassword" type="password" minLength={8} required autoComplete="new-password" /></label><div className="form-actions"><button type="button" className="button button-secondary" onClick={() => setResetTarget(null)}>取消</button><button className="button button-primary"><LockKeyhole size={16} />确认重置</button></div></form></section></div>}
  </>;
}

function AccountSettings() { const { owner, setOwner, notify, logout } = useApp(); async function profile(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); const result = await api<{ owner: Owner }>("/api/me/profile", { method: "PUT", body: JSON.stringify({ displayName: data.get("displayName") }) }); setOwner(result.owner); notify("个人资料已更新", "success"); } async function password(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); await api("/api/me/password", { method: "POST", body: JSON.stringify({ currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword"), confirmPassword: data.get("confirmPassword") }) }); notify("密码已更新，请重新登录", "success"); await logout(); } return <><SettingsHeader title="账号与安全" description="管理显示名称和登录密码。修改密码后，当前会话会立即退出。" /><section className="settings-card"><div className="settings-card-title"><UserRound size={19} /><div><h3>个人资料</h3><p>用户名 @{owner.username} 不可修改。</p></div></div><form className="settings-form" onSubmit={(event) => void profile(event)}><label>显示名称<input name="displayName" defaultValue={owner.displayName} /></label><div className="form-actions"><button className="button button-primary">保存资料</button></div></form></section><section className="settings-card"><div className="settings-card-title"><Shield size={19} /><div><h3>修改密码</h3><p>新密码至少 8 个字符，并需要输入两次确认。</p></div></div><form className="settings-form" onSubmit={(event) => void password(event)}><label>当前密码<input name="currentPassword" type="password" required /></label><div className="form-grid"><label>新密码<input name="newPassword" type="password" minLength={8} required /></label><label>再次输入新密码<input name="confirmPassword" type="password" minLength={8} required /></label></div><div className="form-actions"><button className="button button-primary">更新密码</button></div></form></section></>; }
