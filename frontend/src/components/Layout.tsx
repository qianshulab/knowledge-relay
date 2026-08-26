import { useEffect, useState } from "react";
import { Archive, BookOpen, Bot, ChevronDown, Inbox, Link2, LogOut, Menu, Moon, Search, Settings, Sparkles, Sun, UserRound, Users, Wrench, X, type LucideIcon } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../App";
import SearchDialog from "./SearchDialog";

const navigation = [
  { to: "/inbox", label: "收件台", icon: Inbox },
  { to: "/library", label: "知识库", icon: BookOpen },
  { to: "/obsidian", label: "Obsidian", icon: Archive },
];

const settingsNavigation: Array<{ to: string; label: string; icon: LucideIcon; admin?: boolean }> = [
  { to: "/settings/intake", label: "收件接入", icon: Link2 },
  { to: "/settings/ai", label: "AI 智能整理", icon: Sparkles },
  { to: "/settings/skills", label: "整理能力", icon: Wrench },
  { to: "/settings/users", label: "用户管理", icon: Users, admin: true },
  { to: "/settings/account", label: "账号与安全", icon: UserRound },
];

export default function Layout() {
  const { owner, logout, theme, toggleTheme } = useApp();
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.localStorage.getItem("knowledge-relay-sidebar-collapsed") === "true"; } catch { return false; }
  });
  const [accountOpen, setAccountOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

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
    try { window.localStorage.setItem("knowledge-relay-sidebar-collapsed", String(sidebarCollapsed)); } catch { /* keep the control available without persistent storage */ }
  }, [sidebarCollapsed]);

  function toggleSidebar() {
    if (window.matchMedia("(max-width: 900px)").matches) setMobileOpen(true);
    else setSidebarCollapsed((current) => !current);
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand" onClick={() => navigate("/inbox")} role="button" tabIndex={0}>
          <div className="brand-mark">Z</div><div><strong>知流</strong><span>Knowledge Relay</span></div>
        </div>
        <button className="mobile-close" onClick={() => setMobileOpen(false)} aria-label="关闭导航"><X size={20} /></button>
        <nav className="sidebar-nav" aria-label="主要导航">
          <span className="nav-label">工作空间</span>
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} title={label} onClick={() => setMobileOpen(false)} className={({ isActive }) => isActive || (to === "/library" && location.pathname.startsWith("/reader/")) ? "active" : ""}>
              <Icon size={19} /><span>{label}</span>
            </NavLink>
          ))}
          <NavLink to="/settings/intake" title="系统设置" onClick={() => setMobileOpen(false)} className={location.pathname.startsWith("/settings") ? "active" : ""}>
            <Settings size={19} /><span>系统设置</span>
          </NavLink>
          {location.pathname.startsWith("/settings") && <div className="sidebar-subnav" aria-label="系统设置子菜单">
            {settingsNavigation.filter((item) => !item.admin || owner.role === "admin").map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} title={label} onClick={() => setMobileOpen(false)}><Icon size={15} /><span>{label}</span></NavLink>)}
          </div>}
        </nav>
        <div className="sidebar-status"><Bot size={17} /><div><strong>Nanobot Runtime</strong><span>独立知识处理引擎</span></div></div>
      </aside>
      {mobileOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
      <div className="workspace">
        <header className="workspace-header">
          <button className="icon-button sidebar-toggle" onClick={toggleSidebar} aria-label="切换侧栏" title={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}><Menu size={21} /></button>
          <button className="global-search" onClick={() => setSearchOpen(true)}><Search size={18} /><span>搜索你的个人知识</span><kbd>⌘ K</kbd></button>
          <div className="header-tools">
            <button className="icon-button theme-toggle" onClick={toggleTheme} aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"} title={theme === "light" ? "深色模式" : "浅色模式"}>{theme === "light" ? <Moon size={18} /> : <Sun size={18} />}</button>
            <div className="account-wrap">
              <button className="account-button" onClick={() => setAccountOpen(!accountOpen)}>
                <span className="avatar">{owner.displayName.slice(0, 1).toUpperCase()}</span><span className="account-copy"><strong>{owner.displayName}</strong><small>{owner.role === "admin" ? "管理员" : "独立工作区"}</small></span><ChevronDown size={16} />
              </button>
              {accountOpen && <div className="account-menu">
                <button onClick={() => { navigate("/settings/account"); setAccountOpen(false); }}><UserRound size={17} />账号与安全</button>
                <button className="danger-text" onClick={() => void logout()}><LogOut size={17} />退出登录</button>
              </div>}
            </div>
          </div>
        </header>
        <div className="workspace-content"><Outlet /></div>
      </div>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
