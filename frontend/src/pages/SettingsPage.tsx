import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, CheckCircle2, Copy, KeyRound, Plus, RefreshCw, Settings2, Shield, SlidersHorizontal, Trash2, UserRound, Wrench } from "lucide-react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import type { AgentSettings, ApiToken, BotAccount, ManagedSkill, ModelConnectionResult, Owner, ProviderModelCatalog, ProviderSettings } from "../types";
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

function SkillsSettings() { const { notify } = useApp(); const queryClient = useQueryClient(); const skills = useQuery({ queryKey: ["skills"], queryFn: () => api<{ skills: ManagedSkill[] }>("/api/skills") }); async function toggle(skill: ManagedSkill) { await api(`/api/skills/${skill.id}`, { method: "PUT", body: JSON.stringify({ ...skill, enabled: !skill.enabled }) }); notify(`${skill.name}已${skill.enabled ? "停用" : "启用"}`, "success"); void queryClient.invalidateQueries({ queryKey: ["skills"] }); } return <><SettingsHeader title="整理能力" description="Skills 为不同内容提供专业整理规则，启用状态会即时应用到新收件。" /><section className="skills-grid">{skills.isLoading ? <LoadingState /> : skills.data?.skills.map((skill) => <article className="settings-card skill-card" key={skill.id}><div className="skill-icon"><Wrench size={20} /></div><div><h3>{skill.name}</h3><p>{skill.description}</p><span>{skill.builtin ? "内置能力" : "自定义能力"}</span></div><button className={`toggle-button ${skill.enabled ? "on" : ""}`} onClick={() => void toggle(skill)} aria-label={`${skill.enabled ? "停用" : "启用"}${skill.name}`}><i /></button></article>)}</section></>; }

function UsersSettings() { const { owner, notify } = useApp(); const queryClient = useQueryClient(); const [search, setSearch] = useState(""); const users = useQuery({ queryKey: ["users"], queryFn: () => api<{ users: (Owner & { botCount: number; messageCount: number })[] }>("/api/admin/users") }); const rows = users.data?.users.filter((user) => [user.username, user.displayName].join(" ").toLowerCase().includes(search.toLowerCase())) || []; async function setDisabled(user: Owner) { await api(`/api/admin/users/${user.id}/status`, { method: "PUT", body: JSON.stringify({ disabled: !user.disabled }) }); notify(`用户已${user.disabled ? "启用" : "停用"}`, "success"); void queryClient.invalidateQueries({ queryKey: ["users"] }); } async function removeUser(user: Owner) { const confirmation = window.prompt(`永久删除 @${user.username} 及其所有内容、附件和同步配置。请输入完整用户名确认：`); if (confirmation !== user.username) return; await api(`/api/admin/users/${user.id}`, { method: "DELETE", body: JSON.stringify({ confirmation }) }); notify("用户及其工作区数据已删除", "success"); void queryClient.invalidateQueries({ queryKey: ["users"] }); } return <><SettingsHeader title="用户管理" description="搜索、停用或删除工作区用户。每位用户的数据、模型会话和同步设备相互隔离。" /><section className="settings-card"><label className="table-search">搜索用户<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="用户名或显示名称" /></label><div className="user-table">{rows.map((user) => <div key={user.id}><span className="avatar">{user.displayName.slice(0,1)}</span><div><strong>{user.displayName}</strong><small>@{user.username} · {user.messageCount} 条内容 · {user.botCount} 个微信账号</small></div><span className={`status-badge ${user.disabled ? "danger" : "success"}`}>{user.disabled ? "已停用" : user.role === "admin" ? "管理员" : "正常"}</span>{user.id !== owner.id && <><button className="button button-secondary" onClick={() => void setDisabled(user)}>{user.disabled ? "启用" : "停用"}</button><button className="icon-button danger-text" aria-label={`删除用户 ${user.username}`} onClick={() => void removeUser(user)}><Trash2 size={18} /></button></>}</div>)}</div></section></>; }

function AccountSettings() { const { owner, setOwner, notify, logout } = useApp(); async function profile(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); const result = await api<{ owner: Owner }>("/api/me/profile", { method: "PUT", body: JSON.stringify({ displayName: data.get("displayName") }) }); setOwner(result.owner); notify("个人资料已更新", "success"); } async function password(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); await api("/api/me/password", { method: "POST", body: JSON.stringify({ currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword"), confirmPassword: data.get("confirmPassword") }) }); notify("密码已更新，请重新登录", "success"); await logout(); } return <><SettingsHeader title="账号与安全" description="管理显示名称和登录密码。修改密码后，当前会话会立即退出。" /><section className="settings-card"><div className="settings-card-title"><UserRound size={19} /><div><h3>个人资料</h3><p>用户名 @{owner.username} 不可修改。</p></div></div><form className="settings-form" onSubmit={(event) => void profile(event)}><label>显示名称<input name="displayName" defaultValue={owner.displayName} /></label><div className="form-actions"><button className="button button-primary">保存资料</button></div></form></section><section className="settings-card"><div className="settings-card-title"><Shield size={19} /><div><h3>修改密码</h3><p>新密码至少 8 个字符，并需要输入两次确认。</p></div></div><form className="settings-form" onSubmit={(event) => void password(event)}><label>当前密码<input name="currentPassword" type="password" required /></label><div className="form-grid"><label>新密码<input name="newPassword" type="password" minLength={8} required /></label><label>再次输入新密码<input name="confirmPassword" type="password" minLength={8} required /></label></div><div className="form-actions"><button className="button button-primary">更新密码</button></div></form></section></>; }
