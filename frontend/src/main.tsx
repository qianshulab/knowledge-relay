import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

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
        <App />
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
