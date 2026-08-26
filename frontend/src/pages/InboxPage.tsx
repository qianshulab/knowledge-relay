import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowRight, BookOpen, Bot, Inbox, RefreshCw, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { Dashboard, MessageItem } from "../types";
import KnowledgeRelay from "../components/KnowledgeRelay";
import { EmptyState, LoadingState, PageHeader, StatusBadge, formatDate, formatLabels } from "../components/ui";

type MessageResponse = { messages: MessageItem[]; pagination: { total: number; hasMore: boolean; nextBefore?: number } };

export default function InboxPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<"inbox" | "archived">("inbox");
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api<Dashboard>("/api/dashboard"), refetchInterval: 15_000 });
  const messages = useQuery({
    queryKey: ["messages", state, cursors[page]],
    queryFn: () => api<MessageResponse>(`/api/messages?limit=10&${state === "inbox" ? "active=1" : "state=archived"}${cursors[page] ? `&before=${cursors[page]}` : ""}`),
    refetchInterval: page === 0 ? 12_000 : false,
  });
  const processing = useMemo(() => messages.data?.messages.filter((item) => ["processing", "pending", "queued"].includes(item.agentStatus)) || [], [messages.data]);
  const organized = messages.data?.messages.filter((item) => item.agentStatus === "completed").length || 0;

  function refresh() {
    void Promise.all([queryClient.invalidateQueries({ queryKey: ["dashboard"] }), queryClient.invalidateQueries({ queryKey: ["messages"] })]);
  }

  function nextPage() {
    const cursor = messages.data?.pagination.nextBefore;
    if (!cursor) return;
    setCursors((current) => current[page + 1] === cursor ? current : [...current.slice(0, page + 1), cursor]);
    setPage((value) => value + 1);
  }

  return <main className="page inbox-page">
    <PageHeader eyebrow="INBOX" title="收件台" description="所有新捕获的链接、文字和附件都会先来到这里，整理状态实时更新。" actions={<button className="button button-secondary" onClick={refresh}><RefreshCw size={17} />刷新内容</button>} />
    <section className="metrics-grid" aria-label="收件台概览">
      <article className="metric-card"><span><Inbox size={18} />全部收件</span><strong>{dashboard.data?.messages ?? "—"}</strong><small>当前工作区的全部内容</small></article>
      <article className="metric-card"><span><Bot size={18} />等待处理</span><strong>{dashboard.data?.pending ?? "—"}</strong><small>正在排队或整理中的内容</small></article>
      <article className="metric-card"><span><BookOpen size={18} />本页已整理</span><strong>{organized}</strong><small>可进入知识库阅读</small></article>
      <article className="metric-card"><span><Archive size={18} />同步设备</span><strong>{dashboard.data?.syncTargets.length ?? "—"}</strong><small>已配置的 Obsidian 目标</small></article>
    </section>
    <section className="dashboard-grid">
      <article className="panel relay-panel"><div className="panel-heading"><div><span className="eyebrow">LIVE PIPELINE</span><h2>智能处理流</h2></div><span className={`live-indicator ${processing.length ? "active" : ""}`}>{processing.length ? `正在处理 ${processing.length} 条` : "引擎待命"}</span></div><KnowledgeRelay processing={processing.length > 0} /><p className="relay-caption">{processing[0] ? `正在整理：${processing[0].title || "新收件内容"}` : "收到新内容后，将依次完成理解、分类和知识整理。"}</p></article>
      <article className="panel insights-panel"><div className="panel-heading"><div><span className="eyebrow">WORKSPACE STATUS</span><h2>工作区状态</h2></div></div><div className="status-list"><div><span>微信接入</span><strong>{dashboard.data?.accounts.length ? `${dashboard.data.accounts.length} 个账号已连接` : "尚未连接"}</strong></div><div><span>Obsidian 同步</span><strong>{dashboard.data?.syncTargets.length ? "已配置" : "可选配置"}</strong></div><div><span>当前页面</span><strong>第 {page + 1} 页 · 每页 10 条</strong></div></div><button className="text-link" onClick={() => navigate("/settings/intake")}>管理收件接入 <ArrowRight size={16} /></button></article>
    </section>
    <section className="content-section">
      <div className="section-heading"><div><span className="eyebrow">RECENT CAPTURES</span><h2>最近捕获</h2><p>点击任意内容即可查看整理结果与原始资料。</p></div><div className="segmented-control"><button className={state === "inbox" ? "active" : ""} onClick={() => { setState("inbox"); setPage(0); setCursors([undefined]); }}>当前内容</button><button className={state === "archived" ? "active" : ""} onClick={() => { setState("archived"); setPage(0); setCursors([undefined]); }}>已归档</button></div></div>
      {messages.isLoading ? <LoadingState label="正在加载收件内容" /> : messages.data?.messages.length ? <div className="message-list">{messages.data.messages.map((item) => <button className="message-row" key={item.id} onClick={() => navigate(`/reader/${encodeURIComponent(item.id)}`)}><div className="message-format">{formatLabels[item.contentFormat]?.slice(0, 2) || "内容"}</div><div className="message-main"><div className="message-title-line"><strong>{item.title || item.text.slice(0, 80) || "未命名内容"}</strong><StatusBadge status={item.agentStatus} /></div><p>{item.summary || item.text || "等待整理后生成摘要"}</p><div className="message-meta"><span>{formatLabels[item.contentFormat] || item.contentFormat}</span><span>{formatDate(item.receivedAt)}</span>{item.attachmentCount > 0 && <span>{item.attachmentCount} 个附件</span>}</div></div><ArrowRight className="row-arrow" size={19} /></button>)}</div> : <EmptyState icon={<Inbox size={28} />} title={state === "archived" ? "还没有归档内容" : "收件台是空的"} description={state === "archived" ? "归档后的内容会显示在这里。" : "通过微信 iLink 或 API 发送内容后，会自动出现在这里。"} />}
      <div className="pagination"><button className="button button-secondary" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>上一页</button><span>第 {page + 1} 页</span><button className="button button-secondary" disabled={!messages.data?.pagination.hasMore} onClick={nextPage}>下一页</button></div>
    </section>
  </main>;
}
