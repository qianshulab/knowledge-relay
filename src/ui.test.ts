import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map((channel) => Number.parseInt(channel, 16) / 255).map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe("component frontend", () => {
  it("uses an independent React application instead of an inline admin template", () => {
    const app = read("frontend/src/App.tsx");
    const server = read("src/server.ts");
    expect(app).toContain("<Routes>");
    expect(app).toContain('path="/inbox"');
    expect(app).toContain('path="/library"');
    expect(app).toContain('path="/knowledge-chat"');
    expect(app).toContain('path="/reader/:id"');
    expect(app).toContain('path="/settings/:section"');
    expect(app).toContain('path="/settings/sources"');
    expect(app).toContain('<Navigate to="/settings/intake" replace />');
    expect(server).toContain("fastifyStatic");
    expect(server).toContain('prefix: "/app/"');
    expect(server).toContain("loadWebIndex");
    expect(server).not.toContain("adminPage");
  });

  it("preserves all core product journeys", () => {
    const inbox = read("frontend/src/pages/InboxPage.tsx");
    expect(inbox).toContain("queryClient.prefetchQuery");
    expect(inbox).toContain("await queryClient.fetchQuery");
    expect(inbox).toContain("messagePageMinHeight");
    expect(inbox).toContain("disabled={view.page === 0 || Boolean(pageNavigation)}");
    const library = read("frontend/src/pages/LibraryPage.tsx");
    expect(library).toContain("/api/knowledge/facets?organized=1");
    expect(library).toContain('params.set("format", format)');
    expect(library).not.toContain('active=1&organized=1');
    expect(library).toContain('refetchOnMount: "always"');
    expect(library).toContain("refetchInterval: 20_000");
    expect(library).toContain("const clearFilters = () =>");
    expect(library).toContain("清除筛选并显示全部");
    const reader = read("frontend/src/pages/ReaderPage.tsx");
    expect(reader).toContain("文章正文");
    expect(reader).toContain("智能图解");
    expect(reader).toContain("重新整理");
    expect(reader).toContain("永久删除");
    expect(reader).toContain("ReactMarkdown");
    expect(reader).toContain('attachment.kind === "derived" && attachment.mimeType === "text/markdown"');
    expect(reader).toContain('["article-markdown", messageId, articleAttachment?.id]');
    expect(reader).toContain("children.replace(/attachment:");
    expect(reader).toContain("attachment.sha256.toLowerCase() === hash.toLowerCase()");
    expect(reader).not.toContain("article-image-strip");
    expect(reader).not.toContain("rehypeRaw");
    const diagram = read("frontend/src/components/KnowledgeDiagram.tsx");
    expect(diagram).toContain('addEventListener("wheel", handleWheel, { passive: false })');
    expect(diagram).toContain("setPointerCapture");
    expect(diagram).toContain("适配窗口");
    expect(diagram).toContain("maximumScale = 2.5");
    expect(diagram).toContain("ResizeObserver");
    expect(diagram).toContain('closest(".diagram-node")');
    expect(diagram).toContain("event.stopPropagation(); selectNode(node.id)");
    expect(diagram).toContain("diagram-node-card");
    expect(diagram).toContain("roleNames");
    const settings = read("frontend/src/pages/SettingsPage.tsx");
    for (const journey of ["收件接入", "微信 iLink", "开放 API", "AI 智能整理", "整理能力", "用户管理", "账号与安全"]) {
      expect(settings).toContain(journey);
    }
    expect(settings).toContain("/api/admin/invitations");
    expect(settings).toContain("邀请链接（仅显示一次）");
    expect(settings).toContain("创建邀请");
    expect(settings).toContain("重置用户密码");
    expect(settings).toContain("invitationPageSize");
    const knowledgeChat = read("frontend/src/pages/KnowledgeChatPage.tsx");
    expect(knowledgeChat).toContain("仅依据个人知识库");
    expect(knowledgeChat).toContain("回答依据");
    expect(knowledgeChat).toContain("/api/knowledge/chats");
    expect(knowledgeChat).toContain("/messages/stream");
    expect(knowledgeChat).toContain("streamedAnswer");
    expect(knowledgeChat).toContain("持续提问");
    expect(read("frontend/src/components/Layout.tsx")).toContain('to: "/knowledge-chat"');
    const auth = read("frontend/src/pages/AuthPage.tsx");
    expect(auth).toContain('new URLSearchParams(window.location.search).get("invite")');
    expect(auth).toContain("defaultValue={initialInviteToken}");
    expect(auth).toContain("别让有价值的内容");
    expect(auth).toContain("auth-relay-demo");
    expect(settings).toContain("/api/nanobot/provider/models?provider=");
    expect(settings).toContain("刷新模型列表");
    expect(settings).toContain("保存并检查连接");
    expect(settings).toContain('api<ModelConnectionResult>("/api/agent/test"');
    expect(settings).toContain("if (result.ok)");
    const obsidian = read("frontend/src/pages/ObsidianPage.tsx");
    expect(obsidian).toContain("/api/sync-targets");
    expect(obsidian).toContain('owner.role === "admin"');
    expect(obsidian).toContain('type="file"');
    expect(obsidian).toContain("/api/plugin-release");
    expect(obsidian).toContain("校验并发布");
    expect(obsidian).toContain("10 * 1024 * 1024");
    expect(settings).toContain("分层路由");
    expect(settings).toContain("新建 Skill");
    expect(settings).toContain('api("/api/skills", { method: "POST"');
    expect(diagram).toContain("在图解中查找");
    expect(diagram).toContain("diagram-node-panel");
  });

  it("uses a high-contrast reading system without blurred glass surfaces", () => {
    const styles = read("frontend/src/styles.css");
    expect(styles).toContain("--text: #101828");
    expect(styles).toContain("--surface: #ffffff");
    expect(styles).toContain("font-size: 16px");
    expect(styles).toContain("font-size: 18px");
    expect(styles).toContain("line-height: 1.88");
    expect(styles).toContain(".reader-tabs { position: static;");
    expect(styles).not.toContain(".reader-tabs { position: sticky;");
    expect(read("frontend/src/components/KnowledgeRelay.tsx")).toContain("捕获</span>");
    expect(read("frontend/src/components/KnowledgeRelay.tsx")).toContain("语义整理引擎");
    expect(styles).toContain("@keyframes relay-packet-in");
    expect(styles).toContain("@keyframes relay-stage-dot");
    expect(styles).toContain("prefers-reduced-motion: reduce");
    expect(styles).toContain("height: calc(100dvh - 76px)");
    expect(styles).toContain(".stream-caret");
    expect(styles).not.toContain("backdrop-filter");
    expect(styles).not.toContain("@import url(");
  });

  it("supports persistent light and dark themes with settings nested in the main sidebar", () => {
    const app = read("frontend/src/App.tsx");
    const main = read("frontend/src/main.tsx");
    const layout = read("frontend/src/components/Layout.tsx");
    const settings = read("frontend/src/pages/SettingsPage.tsx");
    const styles = read("frontend/src/styles.css");
    expect(app).toContain('type Theme = "light" | "dark"');
    expect(main).toContain("prefers-color-scheme: dark");
    expect(main).toContain("knowledge-relay-theme");
    expect(layout).toContain("theme-toggle");
    expect(layout).toContain("sidebar-subnav");
    expect(layout).toContain("sidebarCollapsed");
    expect(layout).toContain("knowledge-relay-sidebar-collapsed");
    expect(layout).toContain("toggleSidebar");
    expect(styles).toContain(".app-shell.sidebar-collapsed");
    expect(layout).toContain('to="/settings/intake"');
    expect(layout).not.toContain('to="/settings/api"');
    expect(read("frontend/src/pages/InboxPage.tsx")).toContain("管理内容来源");
    expect(settings).not.toContain("settings-nav");
    expect(styles).toContain(':root[data-theme="dark"]');
    expect(styles).toContain("--text: #f8fafc");
    expect(styles).toContain("--text-secondary: #dce4eb");
    expect(styles).toContain("--text-muted: #b9c5cf");
    expect(styles).toContain("input::placeholder, textarea::placeholder");
    expect(styles).toContain(".search-form input { width: 100%; min-width: 0;");
    expect(styles).toContain("appearance: none; background: transparent;");
    expect(styles).toContain(':root[data-theme="dark"] body { -webkit-font-smoothing: auto; }');
    expect(styles).toContain(".prose .original-text");
    expect(styles).not.toContain(".settings-shell");
  });

  it("keeps every dark theme text tier above enhanced WCAG contrast", () => {
    const surface = "#151c24";
    expect(contrastRatio("#f8fafc", surface)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio("#dce4eb", surface)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio("#b9c5cf", surface)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio("#aab7c2", surface)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio("#6fe0d2", surface)).toBeGreaterThanOrEqual(7);
  });
});
