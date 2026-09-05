import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Bot, ChevronDown, DatabaseBackup, DatabaseZap, HeartPulse, Inbox, Link2, ListTodo, LogOut, Menu, MessageCircleQuestion, Moon, Search, Settings, Sparkles, Sun, UserRound, Users, Wrench, X, type LucideIcon } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../App";
import { api } from "../api";
import type { Dashboard } from "../types";
import Brand from "./Brand";
import SearchDialog from "./SearchDialog";

const navigation = [
  { label: "收集与回顾", items: [
    { to: "/inbox", label: "收件台", icon: Inbox },
    { to: "/review", label: "回顾", icon: HeartPulse },
  ] },
  { label: "理解与使用", items: [
    { to: "/library", label: "知识库", icon: BookOpen },
    { to: "/knowledge-chat", label: "知识问答", icon: MessageCircleQuestion },
  ] },
];

const settingsNavigation: Array<{ to: string; label: string; icon: LucideIcon; admin?: boolean }> = [
  { to: "/settings/intake", label: "收件接入", icon: Link2 },
  { to: "/settings/ai", label: "AI 智能整理", icon: Sparkles },
  { to: "/settings/skills", label: "整理能力", icon: Wrench },
  { to: "/settings/quality", label: "内容质量", icon: HeartPulse },
  { to: "/settings/data", label: "数据与备份", icon: DatabaseBackup },
  { to: "/obsidian", label: "Obsidian 同步", icon: DatabaseZap },
  { to: "/settings/users", label: "用户管理", icon: Users, admin: true },
  { to: "/settings/account", label: "账号与安全", icon: UserRound },
];

const primaryNavigation = navigation.flatMap((group) => group.items);

export default function Layout() {
  const { owner, logout, theme, toggleTheme } = useApp();
  const [searchOpen, setSearchOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<Dashboard>("/api/dashboard"),
    refetchInterval: (query) => query.state.data?.jobs.active ? 4_000 : 20_000,
    staleTime: 8_000,
  });
  const pageContext = useMemo(() => {
    if (location.pathname.startsWith("/reader/")) return { section: "知识库", title: "内容阅读" };
    if (location.pathname.startsWith("/library")) return { section: "知识空间", title: "知识库" };
    if (location.pathname.startsWith("/review")) return { section: "知识空间", title: "回顾" };
    if (location.pathname.startsWith("/knowledge-chat")) return { section: "知识空间", title: "知识问答" };
    if (location.pathname.startsWith("/tasks")) return { section: "知识空间", title: "任务中心" };
    if (location.pathname.startsWith("/obsidian")) return { section: "系统设置", title: "Obsidian 同步" };
    if (location.pathname.startsWith("/settings")) return { section: "系统设置", title: settingsNavigation.find((item) => location.pathname.startsWith(item.to))?.label || "设置" };
    return { section: "工作空间", title: "收件台" };
  }, [location.pathname]);
  const activeJobs = dashboard.data?.jobs.active || 0;
  const failedJobs = dashboard.data?.jobs.failed || 0;
  const settingsActive = location.pathname.startsWith("/settings") || location.pathname.startsWith("/obsidian");
  const availableSettings = settingsNavigation.filter((item) => !item.admin || owner.role === "admin");
  const engineLabel = dashboard.isError
    ? "引擎状态未知"
    : activeJobs
      ? `AI 正在处理 ${activeJobs} 项`
      : failedJobs
        ? `${failedJobs} 项需要关注`
        : "AI 引擎就绪";

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (accountOpen) {
        event.preventDefault();
        setAccountOpen(false);
        window.requestAnimationFrame(() => accountButtonRef.current?.focus());
        return;
      }
      if (navigationOpen) {
        event.preventDefault();
        setNavigationOpen(false);
        window.requestAnimationFrame(() => navigationToggleRef.current?.focus());
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [accountOpen, navigationOpen]);

  useEffect(() => {
    document.title = `${pageContext.title} · 知流`;
    setAccountOpen(false);
    setNavigationOpen(false);
  }, [pageContext.title]);

  useEffect(() => {
    const closeAccount = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    window.addEventListener("pointerdown", closeAccount);
    return () => window.removeEventListener("pointerdown", closeAccount);
  }, []);

  useEffect(() => {
    if (!navigationOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = originalOverflow; };
  }, [navigationOpen]);

  function closeNavigation(restoreFocus = true) {
    setNavigationOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => navigationToggleRef.current?.focus());
  }

  function primaryClass(to: string) {
    if (to === "/library" && location.pathname.startsWith("/reader/")) return "active";
    return location.pathname.startsWith(to) ? "active" : "";
  }

  return (
    <div className={`app-shell ${navigationOpen ? "navigation-open" : ""}`}>
      <a className="skip-link" href="#workspace-main">跳到主要内容</a>
      <header className="workspace-masthead">
        <div className="masthead-primary">
          <button ref={navigationToggleRef} className="icon-button navigation-toggle" type="button" onClick={() => setNavigationOpen(true)} aria-expanded={navigationOpen} aria-controls="workspace-navigation" aria-label="打开全部导航"><Menu size={20} /></button>
          <button className="masthead-brand" type="button" onClick={() => navigate("/inbox")} aria-label="返回收件台"><Brand /></button>
          <button className="global-search" type="button" onClick={() => setSearchOpen(true)}><Search size={18} /><span>查找文章、观点、工具或知识点</span><kbd>⌘ K</kbd></button>
          <div className="header-tools">
            <button className={`engine-pill ${activeJobs ? "is-active" : failedJobs ? "needs-attention" : ""}`} type="button" onClick={() => navigate("/tasks")}><i aria-hidden="true" /><span>{engineLabel}</span></button>
            <button className="icon-button theme-toggle" type="button" onClick={toggleTheme} aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"} title={theme === "light" ? "深色模式" : "浅色模式"}>{theme === "light" ? <Moon size={18} /> : <Sun size={18} />}</button>
            <div className="account-wrap" ref={accountRef}>
              <button ref={accountButtonRef} className="account-button" type="button" onClick={() => setAccountOpen(!accountOpen)} aria-expanded={accountOpen} aria-haspopup="menu">
                <span className="avatar">{owner.displayName.slice(0, 1).toUpperCase()}</span><span className="account-copy"><strong>{owner.displayName}</strong><small>{owner.role === "admin" ? "管理员" : "独立工作区"}</small></span><ChevronDown size={16} />
              </button>
              {accountOpen && <div className="account-menu" role="menu" aria-label="账户菜单">
                <button role="menuitem" type="button" onClick={() => { navigate("/settings/account"); setAccountOpen(false); }}><UserRound size={17} />账号与安全</button>
                <button role="menuitem" type="button" className="danger-text" onClick={() => void logout()}><LogOut size={17} />退出登录</button>
              </div>}
            </div>
          </div>
        </div>
        <div className="masthead-navigation">
          <nav className="primary-navigation" aria-label="工作区导航">
            {primaryNavigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} className={primaryClass(to)}><Icon size={16} /><span>{label}</span></NavLink>)}
            <NavLink to="/tasks" className={primaryClass("/tasks")}><ListTodo size={16} /><span>任务中心</span>{activeJobs > 0 && <b className="nav-count">{activeJobs}</b>}</NavLink>
            <NavLink to="/settings/intake" className={settingsActive ? "active" : ""}><Settings size={16} /><span>系统设置</span></NavLink>
          </nav>
          <div className="masthead-context"><small>{pageContext.section}</small><strong>{pageContext.title}</strong></div>
        </div>
        {settingsActive && <nav className="contextual-navigation" aria-label="系统设置子菜单">
          {availableSettings.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to}><Icon size={15} /><span>{label}</span></NavLink>)}
        </nav>}
      </header>

      {navigationOpen && <>
        <button className="navigation-backdrop" type="button" aria-label="关闭全部导航" onClick={() => closeNavigation()} />
        <aside className="navigation-drawer" id="workspace-navigation" aria-label="全部导航">
          <header className="drawer-head"><button className="drawer-brand" type="button" onClick={() => { navigate("/inbox"); closeNavigation(false); }}><Brand /></button><button className="icon-button drawer-close" type="button" onClick={() => closeNavigation()} aria-label="关闭全部导航"><X size={19} /></button></header>
          <div className="drawer-scroll">
            <nav className="drawer-navigation" aria-label="主要导航">
              {navigation.map((group) => <section className="drawer-group" key={group.label}><span>{group.label}</span>{group.items.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} className={primaryClass(to)} onClick={() => closeNavigation(false)}><Icon size={18} /><span>{label}</span></NavLink>)}</section>)}
              <section className="drawer-group"><span>运行与设置</span><NavLink to="/tasks" className={primaryClass("/tasks")} onClick={() => closeNavigation(false)}><ListTodo size={18} /><span>任务中心</span>{activeJobs > 0 && <b className="nav-count">{activeJobs}</b>}</NavLink><NavLink to="/settings/intake" className={settingsActive ? "active" : ""} onClick={() => closeNavigation(false)}><Settings size={18} /><span>系统设置</span></NavLink></section>
              <section className="drawer-group drawer-settings"><span>设置模块</span>{availableSettings.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} onClick={() => closeNavigation(false)}><Icon size={16} /><span>{label}</span></NavLink>)}</section>
            </nav>
          </div>
          <footer className="drawer-footer"><button className={`drawer-status ${activeJobs ? "is-active" : ""}`} type="button" onClick={() => { navigate("/tasks"); closeNavigation(false); }} title={engineLabel}><span className="runtime-signal"><Bot size={16} /></span><div><strong>{engineLabel}</strong><span>{activeJobs ? "进度已在后台保存" : "Nanobot Runtime"}</span></div></button></footer>
        </aside>
      </>}

      <div className="workspace-atmosphere" aria-hidden="true" />
      <main className="workspace-content" id="workspace-main" key={location.pathname}><Outlet /></main>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
