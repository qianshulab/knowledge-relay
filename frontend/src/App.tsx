import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import type { Owner } from "./types";
import AuthPage from "./pages/AuthPage";
import Layout from "./components/Layout";

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
      <div className="brand-mark">Z</div>
      <strong>知流正在准备你的知识空间</strong>
      <span>正在连接服务与工作区…</span>
    </div>
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
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");

  const toggleTheme = useCallback(() => {
    setTheme((current) => current === "light" ? "dark" : "light");
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
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
    try {
      const bootstrap = await api<{ needsSetup: boolean }>("/api/bootstrap");
      setNeedsSetup(bootstrap.needsSetup);
      if (!bootstrap.needsSetup) {
        try {
          const result = await api<{ owner: Owner }>("/api/me");
          setOwner(result.owner);
        } catch {
          setOwner(null);
        }
      }
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
    await api("/api/logout", { method: "POST" });
    setOwner(null);
  }, []);

  const context = useMemo<AppContextValue | null>(() => owner ? ({ owner, setOwner, theme, toggleTheme, notify, logout }) : null, [logout, notify, owner, theme, toggleTheme]);

  if (loading) return <LoadingScreen />;
  if (!owner) {
    return <><AuthPage needsSetup={needsSetup} onAuthenticated={(next) => { setOwner(next); setNeedsSetup(false); }} /><ToastRegion items={toasts} /></>;
  }

  return (
    <AppContext.Provider value={context}>
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
      <ToastRegion items={toasts} />
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("App context is not available");
  return context;
}
