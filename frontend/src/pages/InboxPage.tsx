import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowRight, BookOpen, Bot, FileArchive, FileText, Image as ImageIcon, Inbox, RefreshCw, Upload, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { Dashboard, MessageItem } from "../types";
import KnowledgeRelay from "../components/KnowledgeRelay";
import { EmptyState, InlineMessage, LoadingState, PageHeader, StatusBadge, formatDate, formatLabels } from "../components/ui";
import { useApp } from "../App";

type MessageResponse = { messages: MessageItem[]; pagination: { total: number; hasMore: boolean; nextBefore?: number } };
type InboxState = "inbox" | "archived";
type InboxView = { state: InboxState; page: number; cursors: (number | undefined)[] };

const pageSize = 10;

function messageQueryKey(state: InboxState, cursor?: number) {
  return ["messages", state, cursor] as const;
}

function loadMessagePage(state: InboxState, cursor?: number) {
  const params = new URLSearchParams({ limit: String(pageSize) });
  if (state === "inbox") params.set("active", "1");
  else params.set("state", "archived");
  if (cursor !== undefined) params.set("before", String(cursor));
  return api<MessageResponse>(`/api/messages?${params.toString()}`);
}

export default function InboxPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useApp();
  const [view, setView] = useState<InboxView>({ state: "inbox", page: 0, cursors: [undefined] });
  const [pageNavigation, setPageNavigation] = useState<string | null>(null);
  const [pageNavigationError, setPageNavigationError] = useState("");
  const navigationLock = useRef(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadNote, setUploadNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const cursor = view.cursors[view.page];
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api<Dashboard>("/api/dashboard"), refetchInterval: (query) => query.state.data?.diagramProcessing ? 3_000 : 15_000 });
  const messages = useQuery({
    queryKey: messageQueryKey(view.state, cursor),
    queryFn: () => loadMessagePage(view.state, cursor),
    placeholderData: keepPreviousData,
    refetchInterval: view.page === 0 ? 12_000 : false,
  });
  const currentPageProcessing = useMemo(
    () => messages.data?.messages.filter((item) => ["processing", "pending", "queued"].includes(item.agentStatus)) || [],
    [messages.data],
  );
  const dashboardData = dashboard.data;
  const dashboardUnavailable = dashboard.isError && !dashboardData;
  const runningAccounts = dashboardData?.accounts.filter((account) => account.state === "running").length || 0;
  const accountCount = dashboardData?.accounts.length || 0;
  const assistantBound = Boolean(dashboardData?.wechatAssistant?.bound);
  const syncTargetCount = dashboardData?.syncTargets.length || 0;
  const primarySyncTarget = dashboardData?.syncTargets.find((target) => target.primary) || dashboardData?.syncTargets[0];
  const pendingCount = dashboardData?.pending || 0;
  const activeProcessingCount = dashboardData?.activeProcessing || 0;
  const queuedCount = dashboardData?.queued || 0;
  const pendingSyncCount = dashboardData?.pendingSync || 0;
  const diagramProcessingCount = dashboardData?.diagramProcessing || 0;
  const diagramJob = dashboardData?.diagramJobs?.[0];

  const accountStatus = dashboardUnavailable
    ? "状态暂不可用"
    : dashboard.isPending
    ? "正在读取"
    : accountCount === 0 && !assistantBound
      ? "尚未连接"
      : assistantBound && accountCount === 0
        ? "微信助手已绑定"
      : assistantBound
        ? `${runningAccounts}/${accountCount} 个 iLink · 助手已绑定`
      : runningAccounts === accountCount
        ? `${runningAccounts} 个账号运行中`
        : runningAccounts > 0
          ? `${runningAccounts}/${accountCount} 个账号运行中`
          : `${accountCount} 个账号已配置 · 当前未运行`;
  const agentStatus = dashboardUnavailable
    ? "状态暂不可用"
    : dashboard.isPending
    ? "正在读取"
    : !dashboardData?.agentEnabled
      ? "未启用"
      : activeProcessingCount > 0 || diagramProcessingCount > 0
        ? `${activeProcessingCount ? `正在整理 ${activeProcessingCount} 条` : ""}${activeProcessingCount && diagramProcessingCount ? " · " : ""}${diagramProcessingCount ? `生成 ${diagramProcessingCount} 个图解` : ""}${queuedCount ? ` · ${queuedCount} 条排队` : ""}`
        : queuedCount > 0
          ? `${queuedCount} 条等待整理`
          : "运行正常 · 当前无任务";
  const syncStatus = dashboardUnavailable
    ? "状态暂不可用"
    : dashboard.isPending
    ? "正在读取"
    : syncTargetCount === 0
      ? "尚未配置"
      : !primarySyncTarget?.lastSeenAt
        ? `${syncTargetCount} 个目标 · 等待首次同步`
        : pendingSyncCount > 0
          ? `${syncTargetCount} 个目标 · ${pendingSyncCount} 条待同步`
          : `${syncTargetCount} 个目标 · 已同步`;
  const pipelineStatus = dashboardUnavailable
    ? "状态暂不可用"
    : dashboard.isPending
    ? "正在读取"
    : activeProcessingCount > 0 || diagramProcessingCount > 0
      ? `${activeProcessingCount ? `整理 ${activeProcessingCount} 条` : ""}${activeProcessingCount && diagramProcessingCount ? " · " : ""}${diagramProcessingCount ? `图解 ${diagramProcessingCount} 个` : ""}`
      : queuedCount > 0
        ? `${queuedCount} 条等待整理`
      : "引擎待命";
  const totalPages = Math.max(1, Math.ceil((messages.data?.pagination.total || 0) / pageSize));
  const workspaceHeadline = dashboardUnavailable
    ? "内容仍可浏览，工作区状态暂时不可用"
    : activeProcessingCount > 0
      ? `正在整理 ${activeProcessingCount} 条新内容`
      : diagramProcessingCount > 0
        ? `正在生成 ${diagramProcessingCount} 个智能图解`
        : queuedCount > 0
          ? `${queuedCount} 条内容已进入整理队列`
          : "工作区已就绪，随时接收新的内容";
  const workspaceSummary = currentPageProcessing[0]
    ? currentPageProcessing[0].title || "新收件内容"
    : diagramJob
      ? diagramJob.title
      : pendingSyncCount > 0
        ? `${pendingSyncCount} 条内容等待同步到 Obsidian`
        : "最近收到的内容、整理结果与同步状态会在这里持续更新。";

  useEffect(() => {
    const nextCursor = messages.data?.pagination.nextBefore;
    if (!messages.data?.pagination.hasMore || nextCursor === undefined) return;
    void queryClient.prefetchQuery({
      queryKey: messageQueryKey(view.state, nextCursor),
      queryFn: () => loadMessagePage(view.state, nextCursor),
      staleTime: 30_000,
    });
  }, [messages.data?.pagination.hasMore, messages.data?.pagination.nextBefore, queryClient, view.state]);

  function refresh() {
    void Promise.all([queryClient.invalidateQueries({ queryKey: ["dashboard"] }), queryClient.invalidateQueries({ queryKey: ["messages"] })]);
  }

  async function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadFiles.length && !uploadNote.trim()) {
      notify("请选择文件或填写文字说明", "danger");
      return;
    }
    const body = new FormData();
    body.set("note", uploadNote.trim());
    uploadFiles.forEach((file) => body.append("files", file, file.name));
    setUploading(true);
    try {
      await api("/api/captures/upload", { method: "POST", body });
      notify(`${uploadFiles.length ? `已接收 ${uploadFiles.length} 个文件` : "内容已接收"}，正在整理`, "success");
      setUploadFiles([]);
      setUploadNote("");
      setUploadOpen(false);
      setView({ state: "inbox", page: 0, cursors: [undefined] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["messages"] }),
      ]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "上传失败，请重试", "danger");
    } finally {
      setUploading(false);
    }
  }

  async function openPage(target: number, targetCursor: number | undefined, nextCursors: (number | undefined)[], label: string) {
    if (navigationLock.current) return;
    navigationLock.current = true;
    const source = view;
    setPageNavigationError("");
    setPageNavigation(label);
    try {
      await queryClient.fetchQuery({
        queryKey: messageQueryKey(source.state, targetCursor),
        queryFn: () => loadMessagePage(source.state, targetCursor),
        staleTime: 15_000,
      });
      setView((current) => current.state === source.state && current.page === source.page
        ? { ...current, page: target, cursors: nextCursors }
        : current);
    } catch {
      setPageNavigationError("切换失败，请重试");
    } finally {
      navigationLock.current = false;
      setPageNavigation(null);
    }
  }

  function previousPage() {
    if (view.page === 0) return;
    const target = view.page - 1;
    void openPage(target, view.cursors[target], view.cursors, "正在打开上一页");
  }

  function nextPage() {
    const nextCursor = messages.data?.pagination.nextBefore;
    if (nextCursor === undefined) return;
    const nextCursors = view.cursors[view.page + 1] === nextCursor
      ? view.cursors
      : [...view.cursors.slice(0, view.page + 1), nextCursor];
    void openPage(view.page + 1, nextCursor, nextCursors, "正在打开下一页");
  }

  async function switchState(state: InboxState) {
    if (state === view.state || navigationLock.current) return;
    navigationLock.current = true;
    setPageNavigationError("");
    setPageNavigation(state === "inbox" ? "正在打开当前内容" : "正在打开已归档内容");
    try {
      await queryClient.fetchQuery({
        queryKey: messageQueryKey(state),
        queryFn: () => loadMessagePage(state),
        staleTime: 15_000,
      });
      setView({ state, page: 0, cursors: [undefined] });
    } catch {
      setPageNavigationError("切换失败，请重试");
    } finally {
      navigationLock.current = false;
      setPageNavigation(null);
    }
  }

  return <main className="page inbox-page">
    <PageHeader eyebrow="CAPTURE DESK" title="收件台" description="收下值得保留的内容，其余整理、索引与同步交给知流。" actions={<div className="page-header-actions"><button className="button button-primary" onClick={() => setUploadOpen(true)}><Upload size={17} />添加内容</button><button className="button button-quiet" onClick={refresh} aria-label="刷新收件台"><RefreshCw size={17} />刷新</button></div>} />
    {dashboardUnavailable && <InlineMessage tone="danger"><span>工作区概览暂时无法读取，内容列表仍可独立使用。</span> <button className="text-link" onClick={() => void dashboard.refetch()}>重新读取</button></InlineMessage>}
    <section className="inbox-command-deck" aria-label="工作区概览">
      <div className="inbox-command-copy">
        <span className={`live-indicator ${pendingCount || diagramProcessingCount ? "active" : ""}`}>{pipelineStatus}</span>
        <h2>{workspaceHeadline}</h2>
        <p>{workspaceSummary}</p>
      </div>
      <dl className="inbox-stat-line">
        <div><dt><Inbox size={16} />全部内容</dt><dd>{dashboard.isPending ? "—" : dashboardUnavailable ? "!" : dashboardData?.messages ?? 0}</dd></div>
        <div><dt><Bot size={16} />待整理</dt><dd>{dashboard.isPending ? "—" : dashboardUnavailable ? "!" : dashboardData?.pending ?? 0}</dd></div>
        <div><dt><BookOpen size={16} />知识条目</dt><dd>{dashboard.isPending ? "—" : dashboardUnavailable ? "!" : dashboardData?.organized ?? 0}</dd></div>
        <div><dt><Archive size={16} />待同步</dt><dd>{dashboard.isPending ? "—" : dashboardUnavailable ? "!" : syncTargetCount ? pendingSyncCount : "—"}</dd></div>
      </dl>
    </section>
    <section className="inbox-workbench">
      <section className="content-section inbox-feed">
        <div className="section-heading"><div><span className="eyebrow">RECENT CAPTURES</span><h2>最近收件</h2><p>按接收时间排列；整理完成后会自动进入知识库。</p></div><div className="segmented-control" aria-busy={Boolean(pageNavigation)}><button className={view.state === "inbox" ? "active" : ""} disabled={Boolean(pageNavigation)} onClick={() => void switchState("inbox")}>当前内容</button><button className={view.state === "archived" ? "active" : ""} disabled={Boolean(pageNavigation)} onClick={() => void switchState("archived")}>已归档</button></div></div>
        <div className="message-page" aria-busy={messages.isPending || messages.isFetching || Boolean(pageNavigation)}>
          {messages.isPending ? <LoadingState label="正在加载收件内容" /> : messages.isError && !messages.data ? <EmptyState icon={<Inbox size={28} />} title="收件内容加载失败" description={messages.error instanceof Error ? messages.error.message : "暂时无法读取收件内容，请稍后重试。"} action={<button className="button button-secondary" onClick={() => void messages.refetch()}><RefreshCw size={16} />重新加载</button>} /> : messages.data?.messages.length ? <div className="message-list">{messages.data.messages.map((item) => <button className="message-row" key={item.id} onClick={() => navigate(`/reader/${encodeURIComponent(item.id)}`)}><div className="message-format">{formatLabels[item.contentFormat]?.slice(0, 2) || "内容"}</div><div className="message-main"><div className="message-title-line"><strong>{item.title || item.text.slice(0, 80) || "未命名内容"}</strong><StatusBadge status={item.agentStatus} /></div><p>{item.summary || item.text || "等待整理后生成摘要"}</p><div className="message-meta"><span>{formatLabels[item.contentFormat] || item.contentFormat}</span><span>{formatDate(item.receivedAt)}</span>{item.attachmentCount > 0 && <span>{item.attachmentCount} 个附件</span>}</div></div><ArrowRight className="row-arrow" size={19} /></button>)}</div> : <EmptyState icon={<Inbox size={28} />} title={view.state === "archived" ? "还没有归档内容" : "收件台是空的"} description={view.state === "archived" ? "归档后的内容会显示在这里。" : "可以直接上传图片、文档和网页资源包，也可以通过微信或 API 发送内容。"} action={view.state === "inbox" ? <button className="button button-primary" onClick={() => setUploadOpen(true)}><Upload size={17} />添加第一条内容</button> : undefined} />}
        </div>
        <div className="pagination"><button className="button button-secondary" disabled={view.page === 0 || Boolean(pageNavigation)} onClick={previousPage}>上一页</button><span className={`pagination-status ${pageNavigationError ? "error" : ""}`} role="status" aria-live="polite">{pageNavigation ? <><RefreshCw className="spin" size={14} />{pageNavigation}</> : pageNavigationError || `第 ${view.page + 1} / ${totalPages} 页`}</span><button className="button button-secondary" disabled={!messages.data?.pagination.hasMore || Boolean(pageNavigation)} onClick={nextPage}>下一页</button></div>
      </section>
      <aside className="inbox-operations" aria-label="自动化与连接状态">
        <section className="inbox-automation">
          <div className="panel-heading"><div><span className="eyebrow">KNOWLEDGE ENGINE</span><h2>整理引擎</h2></div><button className="text-link" onClick={() => navigate("/tasks")}>任务中心 <ArrowRight size={15} /></button></div>
          <KnowledgeRelay processing={activeProcessingCount > 0 || diagramProcessingCount > 0} mode={diagramJob && activeProcessingCount === 0 ? "diagram" : "knowledge"} phase={diagramJob && activeProcessingCount === 0 ? diagramJob.phase : undefined} />
          <p className="relay-caption">{currentPageProcessing[0] ? `正在整理：${currentPageProcessing[0].title || "新收件内容"}` : diagramJob ? `正在生成图解：${diagramJob.title} · ${diagramJob.message}` : pendingCount ? `还有 ${pendingCount} 条内容等待完成整理。` : "收到新内容后，依次完成解析、理解、索引与同步。"}</p>
        </section>
        <section className="inbox-connections">
          <div className="panel-heading"><div><span className="eyebrow">CONNECTIONS</span><h2>连接状态</h2></div></div>
          <div className="status-list">
            <button onClick={() => navigate("/settings/intake")}><span>内容来源</span><strong title={dashboardData?.accounts.find((account) => account.lastError)?.lastError || dashboardData?.wechatAssistant?.error}>{accountStatus}</strong><ArrowRight size={15} /></button>
            <button onClick={() => navigate("/settings/ai")}><span>智能整理</span><strong>{agentStatus}</strong><ArrowRight size={15} /></button>
            <button onClick={() => navigate("/obsidian")}><span>Obsidian</span><strong title={primarySyncTarget?.lastSeenAt ? `最近同步：${formatDate(primarySyncTarget.lastSeenAt)}` : undefined}>{syncStatus}</strong><ArrowRight size={15} /></button>
          </div>
        </section>
      </aside>
    </section>
    {uploadOpen && <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget && !uploading) setUploadOpen(false); }}><section className="capture-upload-modal" role="dialog" aria-modal="true" aria-label="添加收件内容"><header><div><span className="eyebrow">ADD TO INBOX</span><h2>添加内容</h2><p>上传后会自动提取正文、图片与表格，再进入智能整理和知识库。</p></div><button className="icon-button" disabled={uploading} onClick={() => setUploadOpen(false)} aria-label="关闭"><X size={20} /></button></header><form onSubmit={submitUpload}><label className="capture-dropzone"><input type="file" multiple accept="image/jpeg,image/png,image/gif,image/webp,.pdf,.docx,.xlsx,.md,.markdown,.txt,.csv,.tsv,.html,.htm,.xhtml,.zip,.json,.yaml,.yml,.log" onChange={(event) => setUploadFiles(Array.from(event.target.files || []).slice(0, 10))} /><Upload size={28} /><span><strong>{uploadFiles.length ? `已选择 ${uploadFiles.length} 个文件` : "选择图片、文档或资源包"}</strong><small>支持图片、PDF、DOCX、XLSX、Markdown、HTML、ZIP；一次最多 10 个、总计 100 MB</small></span></label>{uploadFiles.length > 0 && <div className="capture-file-list">{uploadFiles.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`}>{file.type.startsWith("image/") ? <ImageIcon size={18} /> : file.name.toLowerCase().endsWith(".zip") ? <FileArchive size={18} /> : <FileText size={18} />}<span><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(file.size > 1024 * 1024 ? 1 : 2)} MB</small></span><button type="button" onClick={() => setUploadFiles((current) => current.filter((_item, itemIndex) => itemIndex !== index))} aria-label={`移除 ${file.name}`}><X size={16} /></button></div>)}</div>}<label className="capture-note"><span>补充说明（可选）</span><textarea value={uploadNote} onChange={(event) => setUploadNote(event.target.value)} placeholder="例如：请重点整理部署步骤、风险和关键结论" rows={3} /></label><footer><button type="button" className="button button-secondary" disabled={uploading} onClick={() => setUploadOpen(false)}>取消</button><button className="button button-primary" disabled={uploading || (!uploadFiles.length && !uploadNote.trim())}>{uploading ? <RefreshCw className="spin" size={17} /> : <Upload size={17} />}{uploading ? "正在上传…" : "加入收件台"}</button></footer></form></section></div>}
  </main>;
}
