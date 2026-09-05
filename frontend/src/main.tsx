import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter } from "react-router-dom";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import "./styles.css";

// A deployment can replace hashed lazy-route files while an older tab is still
// open. Recover once with a fresh document instead of leaving the user on a
// broken or empty route.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  const recoveryKey = "knowledge-relay-ui-recovery";
  const now = Date.now();
  let lastRecovery = 0;
  try { lastRecovery = Number(window.sessionStorage.getItem(recoveryKey) || 0); } catch { /* storage can be unavailable */ }
  if (now - lastRecovery < 15_000) return;
  try { window.sessionStorage.setItem(recoveryKey, String(now)); } catch { /* continue without persistence */ }
  const next = new URL(window.location.href);
  next.searchParams.set("ui", String(now));
  window.location.replace(next.toString());
});

let savedTheme: string | null = null;
try {
  savedTheme = window.localStorage.getItem("knowledge-relay-theme");
} catch {
  // Some privacy modes disable storage; the interface can still follow the system theme.
}
document.documentElement.dataset.theme = savedTheme === "dark" || savedTheme === "light"
  ? savedTheme
  : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <AppErrorBoundary><App /></AppErrorBoundary>
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
