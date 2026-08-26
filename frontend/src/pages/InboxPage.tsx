import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowRight, BookOpen, Bot, Inbox, RefreshCw } from "lucide-react";
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
  const currentPageProcessing = useMemo(
    () => messages.data?.messages.filter((item) => ["processing", "pending", "queued"].includes(item.agentStatus)) || [],
    [messages.data],
  );
  const dashboardData = dashboard.data;
  const runningAccounts = dashboardData?.accounts.filter((account) => account.state === "running").length || 0;
  const accountCount = dashboardData?.accounts.length || 0;
  const syncTargetCount = dashboardData?.syncTargets.length || 0;
  const primarySyncTarget = dashboardData?.syncTargets.find((target) => target.primary) || dashboardData?.syncTargets[0];
  const pendingCount = dashboardData?.pending || 0;
  const activeProcessingCount = dashboardData?.activeProcessing || 0;
  const queuedCount = dashboardData?.queued || 0;
  const pendingSyncCount = dashboardData?.pendingSync || 0;

  const accountStatus = dashboard.isLoading
    ? "正在读取"
    : accountCount === 0
      ? "尚未连接"
      : runningAccounts === accountCount
        ? `${runningAccounts} 个账号运行中`
        : runningAccounts > 0
          ? `${runningAccounts}/${accountCount} 个账号运行中`
          : `${accountCount} 个账号已配置 · 当前未运行`;
  const agentStatus = dashboard.isLoading
    ? "正在读取"
    : !dashboardData?.agentEnabled
      ? "未启用"
      : activeProcessingCount > 0
        ? `正在整理 ${activeProcessingCount} 条${queuedCount ? ` · ${queuedCount} 条排队` : ""}`
        : queuedCount > 0
          ? `${queuedCount} 条等待整理`
          : "运行正常 · 当前无任务";
  const syncStatus = dashboard.isLoading
    ? "正在读取"
    : syncTargetCount === 0
      ? "尚未配置"
      : !primarySyncTarget?.lastSeenAt
        ? `${syncTargetCount} 个目标 · 等待首次同步`
        : pendingSyncCount > 0
          ? `${syncTargetCount} 个目标 · ${pendingSyncCount} 条待同步`
          : `${syncTargetCount} 个目标 · 已同步`;
  const pipelineStatus = dashboard.isLoading
    ? "正在读取"
    : activeProcessingCount > 0
      ? `正在整理 ${activeProcessingCount} 条`
      : queuedCount > 0
        ? `${queuedCount} 条等待整理`
        : "引擎待命";

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
      <article className="metric-card"><span><Inbox size={18} />全部收件</span><strong>{dashboardData?.messages ?? "—"}</strong><small>当前工作区的全部内容</small></article>
      <article className="metric-card"><span><Bot size={18} />待整理</span><strong>{dashboardData?.pending ?? "—"}</strong><small>全工作区排队或整理中的内容</small></article>
      <article className="metric-card"><span><BookOpen size={18} />已整理</span><strong>{dashboardData?.organized ?? "—"}</strong><small>全工作区可进入知识库阅读的内容</small></article>
      <article className="metric-card"><span><Archive size={18} />待同步</span><strong>{dashboard.isLoading ? "—" : syncTargetCount ? pendingSyncCount : "—"}</strong><small>{syncTargetCount ? pendingSyncCount ? "等待主要 Obsidian 目标拉取" : "主要 Obsidian 目标已追平" : "尚未配置 Obsidian 同步"}</small></article>
    </section>
    <section className="dashboard-grid">
      <article className="panel relay-panel"><div className="panel-heading"><div><span className="eyebrow">LIVE PIPELINE</span><h2>智能处理流</h2></div><span className={`live-indicator ${pendingCount ? "active" : ""}`}>{pipelineStatus}</span></div><KnowledgeRelay processing={pendingCount > 0} /><p className="relay-caption">{currentPageProcessing[0] ? `正在整理：${currentPageProcessing[0].title || "新收件内容"}` : pendingCount ? `全工作区还有 ${pendingCount} 条内容等待完成整理。` : "收到新内容后，将依次完成理解、分类和知识整理。"}</p></article>
      <article className="panel insights-panel">
        <div className="panel-heading"><div><span className="eyebrow">WORKSPACE STATUS</span><h2>工作区状态</h2></div></div>
        <div className="status-list">
          <div><span>微信接入</span><strong title={dashboardData?.accounts.find((account) => account.lastError)?.lastError}>{accountStatus}</strong></div>
          <div><span>智能整理</span><strong>{agentStatus}</strong></div>
          <div><span>Obsidian 同步</span><strong title={primarySyncTarget?.lastSeenAt ? `最近同步：${formatDate(primarySyncTarget.lastSeenAt)}` : undefined}>{syncStatus}</strong></div>
        </div>
        <div className="status-actions"><button className="text-link" onClick={() => navigate("/settings/intake")}>管理内容来源 <ArrowRight size={16} /></button><button className="text-link" onClick={() => navigate("/obsidian")}>查看同步设置 <ArrowRight size={16} /></button></div>
      </article>
    </section>
    <section className="content-section">
      <div className="section-heading"><div><span className="eyebrow">RECENT CAPTURES</span><h2>最近捕获</h2><p>点击任意内容即可查看整理结果与原始资料。</p></div><div className="segmented-control"><button className={state === "inbox" ? "active" : ""} onClick={() => { setState("inbox"); setPage(0); setCursors([undefined]); }}>当前内容</button><button className={state === "archived" ? "active" : ""} onClick={() => { setState("archived"); setPage(0); setCursors([undefined]); }}>已归档</button></div></div>
      {messages.isLoading ? <LoadingState label="正在加载收件内容" /> : messages.data?.messages.length ? <div className="message-list">{messages.data.messages.map((item) => <button className="message-row" key={item.id} onClick={() => navigate(`/reader/${encodeURIComponent(item.id)}`)}><div className="message-format">{formatLabels[item.contentFormat]?.slice(0, 2) || "内容"}</div><div className="message-main"><div className="message-title-line"><strong>{item.title || item.text.slice(0, 80) || "未命名内容"}</strong><StatusBadge status={item.agentStatus} /></div><p>{item.summary || item.text || "等待整理后生成摘要"}</p><div className="message-meta"><span>{formatLabels[item.contentFormat] || item.contentFormat}</span><span>{formatDate(item.receivedAt)}</span>{item.attachmentCount > 0 && <span>{item.attachmentCount} 个附件</span>}</div></div><ArrowRight className="row-arrow" size={19} /></button>)}</div> : <EmptyState icon={<Inbox size={28} />} title={state === "archived" ? "还没有归档内容" : "收件台是空的"} description={state === "archived" ? "归档后的内容会显示在这里。" : "通过微信 iLink 或 API 发送内容后，会自动出现在这里。"} />}
      <div className="pagination"><button className="button button-secondary" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>上一页</button><span>第 {page + 1} 页 · 每页 10 条</span><button className="button button-secondary" disabled={!messages.data?.pagination.hasMore} onClick={nextPage}>下一页</button></div>
    </section>
  </main>;
}
