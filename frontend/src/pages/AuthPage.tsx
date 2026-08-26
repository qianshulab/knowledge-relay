import { useState, type FormEvent } from "react";
import { ArrowRight, KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import { api } from "../api";
import type { Owner } from "../types";

type Props = { needsSetup: boolean; onAuthenticated: (owner: Owner) => void };

export default function AuthPage({ needsSetup, onAuthenticated }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
        <div className="auth-story-copy">
          <span className="eyebrow"><Sparkles size={15} /> Personal knowledge workspace</span>
          <h1>把随手保存的内容，<br />变成随时找得到的知识。</h1>
          <p>接收微信、网页与附件，保留原文，自动整理，并在网页或 Obsidian 中持续使用。</p>
        </div>
        <div className="auth-trust">
          <span><ShieldCheck size={18} /> 私有部署</span>
          <span><KeyRound size={18} /> 数据与凭据由你掌控</span>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-heading">
            <span className="eyebrow">{needsSetup ? "First setup" : register ? "Invitation" : "Welcome back"}</span>
            <h2>{needsSetup ? "创建管理员账户" : register ? "使用邀请加入" : "登录知流"}</h2>
            <p>{needsSetup ? "完成后即可连接内容来源并开始整理。" : "进入你的独立知识工作区。"}</p>
          </div>
          <form onSubmit={submit} className="form-stack">
            {register && <label>邀请码<input name="inviteToken" required autoComplete="off" /></label>}
            <label>用户名<input name="username" required autoComplete="username" /></label>
            {(needsSetup || register) && <label>显示名称<input name="displayName" required autoComplete="name" /></label>}
            <label>密码<input name="password" type="password" required minLength={8} autoComplete={needsSetup || register ? "new-password" : "current-password"} /></label>
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="button button-primary button-lg" disabled={busy}>
              {busy ? "正在验证…" : needsSetup ? "创建并进入" : register ? "加入工作区" : "登录"}<ArrowRight size={18} />
            </button>
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
