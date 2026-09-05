import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, BookOpen, Bot, Eye, EyeOff, FileText, Image, KeyRound, Link2, LockKeyhole, Moon, Search, ShieldCheck, Sparkles, Sun, UserRound } from "lucide-react";
import { ApiError, api } from "../api";
import type { Owner } from "../types";
import Brand from "../components/Brand";

type Props = { needsSetup: boolean; theme: "light" | "dark"; onToggleTheme: () => void; onAuthenticated: (owner: Owner) => void };

export default function AuthPage({ needsSetup, theme, onToggleTheme, onAuthenticated }: Props) {
  const [initialInviteToken] = useState(() => new URLSearchParams(window.location.search).get("invite") || "");
  const [mode, setMode] = useState<"login" | "register">(() => initialInviteToken ? "register" : "login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

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
      if (reason instanceof ApiError && reason.status === 401) setError("用户名或密码不正确，请重新输入。");
      else if (reason instanceof ApiError && reason.status === 429) setError("尝试次数较多，请稍候再试。");
      else if (reason instanceof TypeError) setError("暂时无法连接知流服务，请确认服务正在运行。");
      else setError(reason instanceof Error ? reason.message : "暂时无法完成验证，请稍后再试。");
    } finally {
      setBusy(false);
    }
  }

  const register = !needsSetup && mode === "register";
  return (
    <main className="auth-page">
      <div className="auth-ambient" aria-hidden="true"><i /><i /><i /></div>
      <header className="auth-topbar">
        <Brand inverse />
        <div className="auth-topbar-actions">
          <span className="auth-private-mark"><ShieldCheck size={14} />自托管 · 私有数据</span>
          <button className="icon-button auth-theme-toggle" type="button" onClick={onToggleTheme} aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"}>{theme === "light" ? <Moon size={18} /> : <Sun size={18} />}</button>
        </div>
      </header>
      <div className="auth-composition">
      <section className="auth-story">
        <div className="auth-story-center">
          <div className="auth-story-copy">
            <span className="eyebrow"><Sparkles size={15} /> Your knowledge, on recall</span>
            <h1>把散落在各处的好内容，<br />收回到自己的知识里。</h1>
            <p>公众号、网页、图片与文档统一收件，原文完整留存。知流在后台持续整理、关联和建立索引，让曾经保存的内容在需要时立即可用。</p>
          </div>
          <div className="auth-knowledge-scene" aria-hidden="true">
            <div className="auth-source-card source-wechat"><FileText size={16} /><span><strong>公众号文章</strong><small>正文与图片已保存</small></span></div>
            <div className="auth-source-card source-web"><Link2 size={16} /><span><strong>网页资料</strong><small>完整快照</small></span></div>
            <div className="auth-source-card source-file"><Image size={16} /><span><strong>图片与文档</strong><small>识别内容</small></span></div>
            <div className="auth-intelligence-core"><span className="core-halo" /><span className="core-grid" /><Bot size={26} /><strong>持续理解</strong><small>整理 · 关联 · 索引</small></div>
            <div className="auth-memory-card"><span><Search size={15} />按记忆寻找</span><strong>找到那篇记不清标题的文章</strong><small>语义检索 · 来源可追溯</small></div>
            <svg className="auth-connection-lines" viewBox="0 0 720 250" preserveAspectRatio="none"><path d="M130 52 C260 52 250 124 355 124" /><path d="M150 126 C260 126 270 124 355 124" /><path d="M140 204 C260 204 270 124 355 124" /><path d="M430 124 C520 124 510 126 590 126" /></svg>
          </div>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-panel-brand"><span>{needsSetup ? "01 · 初始化" : register ? "邀请注册" : "安全登录"}</span><span className="auth-local-badge"><ShieldCheck size={13} />私有空间</span></div>
          <div className="auth-heading">
            <span className="eyebrow">{needsSetup ? "Workspace setup" : register ? "Join workspace" : "Welcome back"}</span>
            <h2>{needsSetup ? "创建你的知识工作台" : register ? "接受邀请，建立个人空间" : "继续回到知流"}</h2>
            <p>{needsSetup ? "先创建管理员账户，随后连接内容来源和 AI 模型。" : register ? "每位用户拥有独立的收件、知识库、问答与同步配置。" : "继续整理、阅读，并找回曾经保存的重要内容。"}</p>
          </div>
          <form onSubmit={submit} className="form-stack">
            {register && <label><span>邀请码</span><span className="auth-input"><KeyRound size={17} /><input name="inviteToken" required autoComplete="off" defaultValue={initialInviteToken} placeholder="输入管理员提供的邀请码" /></span></label>}
            <label><span>用户名</span><span className="auth-input"><UserRound size={17} /><input name="username" required autoComplete="username" placeholder="输入用户名" /></span></label>
            {(needsSetup || register) && <label><span>显示名称</span><span className="auth-input"><Sparkles size={17} /><input name="displayName" required autoComplete="name" placeholder="你希望显示的名字" /></span></label>}
            <label><span>密码</span><span className="auth-input"><LockKeyhole size={17} /><input name="password" type={showPassword ? "text" : "password"} required minLength={8} autoComplete={needsSetup || register ? "new-password" : "current-password"} placeholder="至少 8 个字符" onKeyDown={(event) => setCapsLock(event.getModifierState("CapsLock"))} onKeyUp={(event) => setCapsLock(event.getModifierState("CapsLock"))} onBlur={() => setCapsLock(false)} /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>{capsLock && <small className="auth-field-hint">大写锁定已开启</small>}</label>
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="button button-primary button-lg" disabled={busy}>
              {busy ? "正在安全验证…" : needsSetup ? "创建空间并继续" : register ? "加入并开始使用" : "进入工作台"}<ArrowRight size={18} />
            </button>
            <small className="auth-security-note"><ShieldCheck size={14} />登录凭据只发送到当前部署的知流服务</small>
          </form>
          {!needsSetup && (
            <button className="auth-switch" type="button" onClick={() => { setMode(register ? "login" : "register"); setError(""); }}>
              {register ? "已有账户？返回登录" : "第一次使用？通过邀请码创建账户"}
            </button>
          )}
          {!needsSetup && !register && <p className="auth-admin-help">忘记密码？请联系当前知流工作区管理员重置。</p>}
          <div className="auth-card-footer"><span>知识只属于你</span><i /><span>答案均可追溯</span><i /><span>无需上传第三方平台</span></div>
        </div>
      </section>
      </div>
      <div className="auth-trust">
        <span><ShieldCheck size={18} /><strong>私有部署</strong><small>数据边界由你掌控</small></span>
        <span><BookOpen size={18} /><strong>保留原始资料</strong><small>正文、附件和来源可追溯</small></span>
        <span><KeyRound size={18} /><strong>模型自由</strong><small>连接你选择的模型服务</small></span>
      </div>
    </main>
  );
}
