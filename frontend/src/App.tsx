import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AlertTriangle, Moon, RefreshCw, Sun } from "lucide-react";
import { ApiError, api } from "./api";
import type { Owner } from "./types";
import AuthPage from "./pages/AuthPage";
import Layout from "./components/Layout";
import { ConfirmDialogProvider } from "./components/ConfirmDialog";
import Brand from "./components/Brand";

const InboxPage = lazy(() => import("./pages/InboxPage"));
const ReviewPage = lazy(() => import("./pages/ReviewPage"));
const LibraryPage = lazy(() => import("./pages/LibraryPage"));
const ReaderPage = lazy(() => import("./pages/ReaderPage"));
const KnowledgeChatPage = lazy(() => import("./pages/KnowledgeChatPage"));
const TaskCenterPage = lazy(() => import("./pages/TaskCenterPage"));
const ObsidianPage = lazy(() => import("./pages/ObsidianPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

type Toast = { id: number; message: string; tone: "default" | "success" | "danger" };
type Theme = "light" | "dark";
type AppContextValue = {
  owner: Owner;
  setOwner: (owner: Owner) => void;
  theme: Theme;
  toggleTheme: () => void;
  notify: (message: string, tone?: Toast["tone"]) => void;
  logout: () => Promise<void>;
};

export const AppContext = createContext<AppContextValue | null>(null);

function LoadingScreen() {
  return (
    <div className="boot-screen" aria-live="polite">
      <Brand />
      <strong>知流正在准备你的知识空间</strong>
      <span>正在连接服务与工作区…</span>
    </div>
  );
}

function ServiceUnavailable({ onRetry, theme, onToggleTheme }: { onRetry: () => void; theme: Theme; onToggleTheme: () => void }) {
  return (
    <main className="service-unavailable">
      <header><Brand /><button className="icon-button" type="button" onClick={onToggleTheme} aria-label="切换主题">{theme === "light" ? <Moon size={18} /> : <Sun size={18} />}</button></header>
      <section>
        <span><AlertTriangle size={24} /></span>
        <div className="eyebrow">CONNECTION PAUSED</div>
        <h1>暂时无法连接知流服务</h1>
        <p>你的知识与设置没有丢失。请确认服务正在运行或稍后重试。</p>
        <button className="button button-primary button-lg" type="button" onClick={onRetry}><RefreshCw size={17} />重新连接</button>
      </section>
    </main>
  );
}

function RouteLoading() {
  return (
    <main className="page route-loading" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <div><strong>正在打开页面</strong><small>知识工作台保持在线</small></div>
    </main>
  );
}

function ToastRegion({ items }: { items: Toast[] }) {
  return (
    <div className="toast-region" aria-live="polite" aria-atomic="true">
      {items.map((item) => <div key={item.id} className={`toast toast-${item.tone}`}>{item.message}</div>)}
    </div>
  );
}

export default function App() {
  const [owner, setOwner] = useState<Owner | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");

  const toggleTheme = useCallback(() => {
    setTheme((current) => current === "light" ? "dark" : "light");
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0d0f17" : "#f5f3ef");
    try {
      window.localStorage.setItem("knowledge-relay-theme", theme);
    } catch {
      // Keep theme switching available when persistent browser storage is disabled.
    }
  }, [theme]);

  const notify = useCallback((message: string, tone: Toast["tone"] = "default") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 4200);
  }, []);

  const loadSession = useCallback(async () => {
    setLoading(true);
    setServiceUnavailable(false);
    try {
      const bootstrap = await api<{ needsSetup: boolean }>("/api/bootstrap");
      setNeedsSetup(bootstrap.needsSetup);
      if (!bootstrap.needsSetup) {
        try {
          const result = await api<{ owner: Owner }>("/api/me");
          setOwner(result.owner);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) setOwner(null);
          else throw error;
        }
      }
    } catch {
      setServiceUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadSession(); }, [loadSession]);
  useEffect(() => {
    const unauthorized = () => setOwner(null);
    window.addEventListener("knowledge-relay:unauthorized", unauthorized);
    return () => window.removeEventListener("knowledge-relay:unauthorized", unauthorized);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/api/logout", { method: "POST" });
      setOwner(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setOwner(null);
        return;
      }
      notify(error instanceof Error ? `退出失败：${error.message}` : "退出失败，请稍后重试", "danger");
    }
  }, [notify]);

  const context = useMemo<AppContextValue | null>(() => owner ? ({ owner, setOwner, theme, toggleTheme, notify, logout }) : null, [logout, notify, owner, theme, toggleTheme]);

  if (loading) return <LoadingScreen />;
  if (serviceUnavailable) return <ServiceUnavailable onRetry={() => void loadSession()} theme={theme} onToggleTheme={toggleTheme} />;
  if (!owner) {
    return <><AuthPage needsSetup={needsSetup} theme={theme} onToggleTheme={toggleTheme} onAuthenticated={(next) => { setOwner(next); setNeedsSetup(false); }} /><ToastRegion items={toasts} /></>;
  }

  return (
    <AppContext.Provider value={context}>
      <ConfirmDialogProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/inbox" element={<Suspense fallback={<RouteLoading />}><InboxPage /></Suspense>} />
            <Route path="/review" element={<Suspense fallback={<RouteLoading />}><ReviewPage /></Suspense>} />
            <Route path="/library" element={<Suspense fallback={<RouteLoading />}><LibraryPage /></Suspense>} />
            <Route path="/knowledge-chat" element={<Suspense fallback={<RouteLoading />}><KnowledgeChatPage /></Suspense>} />
            <Route path="/tasks" element={<Suspense fallback={<RouteLoading />}><TaskCenterPage /></Suspense>} />
            <Route path="/reader/:id" element={<Suspense fallback={<RouteLoading />}><ReaderPage /></Suspense>} />
            <Route path="/obsidian" element={<Suspense fallback={<RouteLoading />}><ObsidianPage /></Suspense>} />
            <Route path="/settings" element={<Navigate to="/settings/intake" replace />} />
            <Route path="/settings/sources" element={<Navigate to="/settings/intake" replace />} />
            <Route path="/settings/api" element={<Navigate to="/settings/intake" replace />} />
            <Route path="/settings/:section" element={<Suspense fallback={<RouteLoading />}><SettingsPage /></Suspense>} />
            <Route path="*" element={<Navigate to="/inbox" replace />} />
          </Route>
        </Routes>
      </ConfirmDialogProvider>
      <ToastRegion items={toasts} />
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("App context is not available");
  return context;
}
