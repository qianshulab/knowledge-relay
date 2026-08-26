import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, BookOpen, FileText, KeyRound, Search, ShieldCheck, Sparkles } from "lucide-react";
import { api } from "../api";
import type { Owner } from "../types";

type Props = { needsSetup: boolean; onAuthenticated: (owner: Owner) => void };

export default function AuthPage({ needsSetup, onAuthenticated }: Props) {
  const [initialInviteToken] = useState(() => new URLSearchParams(window.location.search).get("invite") || "");
  const [mode, setMode] = useState<"login" | "register">(() => initialInviteToken ? "register" : "login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!initialInviteToken) return;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("invite");
    window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  }, [initialInviteToken]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const payload = {
      username: String(data.get("username") || ""),
      displayName: String(data.get("displayName") || ""),
      password: String(data.get("password") || ""),
      inviteToken: String(data.get("inviteToken") || ""),
    };
    try {
      const endpoint = needsSetup ? "/api/setup" : mode === "register" ? "/api/register" : "/api/login";
      const result = await api<{ owner: Owner }>(endpoint, { method: "POST", body: JSON.stringify(payload) });
      onAuthenticated(result.owner);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  const register = !needsSetup && mode === "register";
  return (
    <main className="auth-page">
      <section className="auth-story">
        <div className="brand-lockup"><div className="brand-mark">Z</div><div><strong>知流</strong><span>Knowledge Relay</span></div></div>
        <div className="auth-story-center">
          <div className="auth-story-copy">
            <span className="eyebrow"><Sparkles size={15} /> Your private knowledge relay</span>
            <h1>别让有价值的内容，<br />消失在收藏夹里。</h1>
            <p>把发给文件助手、留在浏览器和散落在附件里的资料汇入一处。知流会保留原文、完成整理，让它们在需要时重新出现。</p>
          </div>
          <div className="auth-relay-demo" aria-hidden="true">
            <div className="auth-relay-sources"><span><FileText size={15} />公众号文章</span><span><BookOpen size={15} />网页与文档</span></div>
            <div className="auth-relay-stream"><i /><i /><i /></div>
            <div className="auth-relay-core"><Sparkles size={21} /><strong>理解与整理</strong><small>Nanobot Runtime</small></div>
            <div className="auth-relay-stream reverse"><i /><i /><i /></div>
            <div className="auth-relay-result"><Search size={16} /><div><strong>随时找回</strong><small>阅读 · 检索 · 问答</small></div></div>
          </div>
        </div>
        <div className="auth-trust">
          <span><ShieldCheck size={18} /> 私有部署</span>
          <span><KeyRound size={18} /> 数据与模型凭据由你掌控</span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-panel-brand"><span>Z</span><div><strong>知流</strong><small>你的私人知识工作区</small></div></div>
          <div className="auth-heading">
            <span className="eyebrow">{needsSetup ? "First setup" : register ? "Invitation" : "Welcome back"}</span>
            <h2>{needsSetup ? "创建管理员账户" : register ? "使用邀请加入" : "继续使用知流"}</h2>
            <p>{needsSetup ? "完成初始化后，即可接入内容来源并开始整理。" : register ? "创建账户后，你将获得数据完全隔离的个人知识空间。" : "登录后继续阅读、检索和使用已保存的内容。"}</p>
          </div>
          <form onSubmit={submit} className="form-stack">
            {register && <label>邀请码<input name="inviteToken" required autoComplete="off" defaultValue={initialInviteToken} /></label>}
            <label>用户名<input name="username" required autoComplete="username" /></label>
            {(needsSetup || register) && <label>显示名称<input name="displayName" required autoComplete="name" /></label>}
            <label>密码<input name="password" type="password" required minLength={8} autoComplete={needsSetup || register ? "new-password" : "current-password"} /></label>
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="button button-primary button-lg" disabled={busy}>
              {busy ? "正在验证…" : needsSetup ? "创建并进入" : register ? "加入工作区" : "登录"}<ArrowRight size={18} />
            </button>
            <small className="auth-security-note"><ShieldCheck size={14} />凭据仅用于连接你部署的知流服务</small>
          </form>
          {!needsSetup && (
            <button className="auth-switch" type="button" onClick={() => { setMode(register ? "login" : "register"); setError(""); }}>
              {register ? "已有账户？返回登录" : "收到邀请码？创建账户"}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
