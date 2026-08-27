import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeft, Download, FileText, Image as ImageIcon, Network, RefreshCw, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate, useParams } from "react-router-dom";
import { api, attachmentUrl } from "../api";
import type { KnowledgeMap, MessageDetail } from "../types";
import { useApp } from "../App";
import KnowledgeDiagram from "../components/KnowledgeDiagram";
import { EmptyState, LoadingState, formatBytes, formatDate, formatLabels } from "../components/ui";

type DiagramResponse = {
  status: "ready" | "not_generated" | "generating" | "failed";
  cached: boolean;
  diagram?: KnowledgeMap;
  generation?: {
    phase: "analyzing" | "saving";
    message: string;
    startedAt: string;
    updatedAt: string;
    error?: string;
  };
};

export default function ReaderPage() {
  const { id = "" } = useParams();
  const messageId = decodeURIComponent(id);
  const navigate = useNavigate();
  const { notify } = useApp();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"article" | "notes" | "details" | "original">("article");
  const [diagramOpen, setDiagramOpen] = useState(false);
  const [diagramClock, setDiagramClock] = useState(Date.now());
  const previousDiagramStatus = useRef<DiagramResponse["status"] | undefined>(undefined);
  const detail = useQuery({ queryKey: ["message", messageId], queryFn: () => api<MessageDetail>(`/api/messages/${encodeURIComponent(messageId)}`), enabled: Boolean(messageId), refetchInterval: (query) => ["processing", "pending", "queued"].includes(query.state.data?.agentStatus || "") ? 3000 : false });
  const articleAttachment = detail.data?.attachments.find((attachment) => attachment.kind === "derived" && attachment.mimeType === "text/markdown");
  const articleSnapshot = useQuery({
    queryKey: ["article-markdown", messageId, articleAttachment?.id],
    queryFn: () => api<string>(attachmentUrl(articleAttachment!.id)),
    enabled: Boolean(articleAttachment?.id),
    staleTime: Infinity,
  });
  const diagram = useQuery({
    queryKey: ["diagram", messageId],
    queryFn: () => api<DiagramResponse>(`/api/messages/${encodeURIComponent(messageId)}/diagram`),
    enabled: Boolean(messageId),
    refetchInterval: (query) => query.state.data?.status === "generating" ? 2_000 : false,
    refetchOnWindowFocus: true,
  });
  const reprocess = useMutation({ mutationFn: () => api(`/api/messages/${encodeURIComponent(messageId)}/reprocess`, { method: "POST" }), onSuccess: () => { notify("已加入重新整理队列", "success"); void queryClient.invalidateQueries({ queryKey: ["message", messageId] }); } });
  const generateDiagram = useMutation({
    mutationFn: (force: boolean) => api<DiagramResponse>(`/api/messages/${encodeURIComponent(messageId)}/diagram`, { method: "POST", body: JSON.stringify({ force }) }),
    onSuccess: (data) => {
      queryClient.setQueryData(["diagram", messageId], data);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      notify(data.status === "ready" ? "智能图解已生成" : "已在后台开始生成，关闭窗口不会中断", "success");
    },
    onError: (error) => notify(error instanceof Error ? error.message : "图解生成失败", "danger"),
  });

  useEffect(() => { if (detail.data && !detail.data.readAt) void api(`/api/messages/${encodeURIComponent(messageId)}/library`, { method: "PATCH", body: JSON.stringify({ read: true }) }); }, [detail.data, messageId]);

  useEffect(() => {
    if (diagram.data?.status !== "generating") return;
    setDiagramClock(Date.now());
    const timer = window.setInterval(() => setDiagramClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [diagram.data?.status, diagram.data?.generation?.startedAt]);

  useEffect(() => {
    const status = diagram.data?.status;
    if (!status) return;
    if (previousDiagramStatus.current === "generating" && status === "ready") {
      notify("智能图解已生成，可以打开查看", "success");
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } else if (previousDiagramStatus.current === "generating" && status === "failed") {
      notify(diagram.data?.generation?.error || "智能图解生成失败，可重新尝试", "danger");
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
    previousDiagramStatus.current = status;
  }, [diagram.data, notify, queryClient]);

  async function changeState(state: "inbox" | "archived") {
    await api(`/api/messages/${encodeURIComponent(messageId)}/library`, { method: "PATCH", body: JSON.stringify({ state }) });
    notify(state === "inbox" ? "已恢复到收件台" : "已归档", "success");
    void queryClient.invalidateQueries({ queryKey: ["message", messageId] });
    void queryClient.invalidateQueries({ queryKey: ["messages"] });
  }

  async function remove() {
    if (!window.confirm("永久删除后，原始内容、附件和所有整理结果都无法恢复。确定继续吗？")) return;
    await api(`/api/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
    notify("内容已永久删除", "success");
    navigate("/inbox", { replace: true });
  }

  if (detail.isLoading) return <main className="page"><LoadingState label="正在打开内容" /></main>;
  if (!detail.data) return <main className="page"><EmptyState title="内容不存在" description="这条内容可能已被删除。" action={<button className="button button-secondary" onClick={() => navigate(-1)}>返回</button>} /></main>;
  const item = detail.data;
  const article = articleSnapshot.data || item.contentMarkdown || item.markdown || item.detailsMarkdown || item.text;
  const sourceImages = item.attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const files = item.attachments.filter((attachment) => !attachment.mimeType.startsWith("image/") && attachment.id !== articleAttachment?.id);
  const hasInlineImages = /!\[[^\]]*\]\([^)]+\)/.test(article);
  const showStandaloneImages = !articleAttachment && !hasInlineImages && item.contentFormat === "image";
  const diagramElapsed = diagram.data?.generation?.startedAt
    ? Math.max(0, Math.floor((diagramClock - new Date(diagram.data.generation.startedAt).getTime()) / 1_000))
    : 0;
  const diagramElapsedLabel = diagramElapsed < 60
    ? `${diagramElapsed} 秒`
    : `${Math.floor(diagramElapsed / 60)} 分 ${diagramElapsed % 60} 秒`;

  const Markdown = ({ children }: { children: string }) => {
    const resolvedMarkdown = children.replace(/attachment:\/\/([a-f0-9]{64})/gi, (reference, hash: string) => {
      const local = sourceImages.find((attachment) => attachment.sha256.toLowerCase() === hash.toLowerCase());
      return local ? attachmentUrl(local.id) : reference;
    });
    return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ src = "", alt = "" }) => {
    let decoded = src;
    try { decoded = decodeURIComponent(src); } catch { /* preserve malformed source text */ }
    const fileName = decoded.split(/[\\/]/).at(-1)?.split(/[?#]/)[0] || "";
    const local = sourceImages.find((attachment) => attachment.fileName === fileName);
    return <img src={local ? attachmentUrl(local.id) : src} alt={alt} loading="lazy" />;
  } }}>{resolvedMarkdown}</ReactMarkdown>;
  };

  return <main className="reader-page">
    <header className="reader-hero"><button className="back-link" onClick={() => navigate(-1)}><ArrowLeft size={18} />返回</button><div className="reader-title-wrap"><span className="eyebrow">KNOWLEDGE READING</span><h1>{item.title}</h1><div className="reader-meta"><span>{formatLabels[item.contentFormat] || item.category}</span>{item.domains.slice(0, 2).map((value) => <span key={value}>{value}</span>)}<span>{item.source?.name || "收件内容"}</span><time>{formatDate(item.receivedAt).slice(0, 10)}</time></div></div><div className="reader-actions"><button className="button button-secondary" onClick={() => void changeState(item.libraryState === "archived" ? "inbox" : "archived")}><Archive size={17} />{item.libraryState === "archived" ? "恢复到收件台" : "归档"}</button><button className="button button-secondary" onClick={() => setDiagramOpen(true)}>{diagram.data?.status === "generating" ? <RefreshCw className="spin" size={17} /> : <Network size={17} />}{diagram.data?.status === "generating" ? "图解生成中" : "智能图解"}</button><button className="button button-secondary" disabled={reprocess.isPending} onClick={() => reprocess.mutate()}><RefreshCw size={17} />{reprocess.isPending ? "已提交" : "重新整理"}</button><button className="button button-danger" onClick={() => void remove()}><Trash2 size={17} />永久删除</button></div></header>
    <div className="reader-layout"><article className="reader-paper"><nav className="reader-tabs">{([['article','文章正文'],['notes','整理笔记'],['details','延伸整理'],['original','原始内容']] as const).map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>)}</nav><div className="prose">{tab === "article" ? articleAttachment && articleSnapshot.isLoading ? <LoadingState label="正在还原原文版式" /> : <Markdown>{article}</Markdown> : tab === "notes" ? <><h2>内容摘要</h2><p>{item.summary || "暂无摘要"}</p>{item.keyPoints.length > 0 && <><h2>核心要点</h2><ul>{item.keyPoints.map((point) => <li key={point}>{point}</li>)}</ul></>}</> : tab === "details" ? <Markdown>{item.detailsMarkdown || "暂无延伸整理内容。"}</Markdown> : <pre className="original-text">{item.text}</pre>}{tab === "article" && showStandaloneImages && sourceImages.map((image) => <img key={image.id} src={attachmentUrl(image.id)} alt={image.fileName} loading="lazy" />)}</div></article>
      <aside className="reader-aside"><section className="aside-card"><h2>AI 摘要</h2><p>{item.summary || "等待整理后生成摘要。"}</p>{item.source?.url && <a href={item.source.url} target="_blank" rel="noreferrer">查看原始网页 ↗</a>}</section><section className="aside-card"><h2>知识索引</h2><div className="aside-facts"><div><span>内容形态</span><strong>{formatLabels[item.contentFormat] || item.category}</strong></div><div><span>整理状态</span><strong>{item.agentStatus === "completed" ? "已整理" : item.agentStatus}</strong></div><div><span>置信度</span><strong>{item.confidence || "—"}</strong></div></div><div className="tag-row">{[...item.domains, ...item.knowledgePoints, ...item.tools].slice(0, 10).map((value) => <span key={value}>{value}</span>)}</div></section>{item.attachments.length > 0 && <section className="aside-card"><h2>内容资产</h2><div className="asset-list">{files.map((file) => <a key={file.id} href={`${attachmentUrl(file.id)}?download=1`}><FileText size={18} /><span><strong>{file.fileName}</strong><small>{formatBytes(file.size)}</small></span><Download size={17} /></a>)}{sourceImages.length > 0 && <div className="asset-summary"><ImageIcon size={18} /><span><strong>正文图片已本地保存</strong><small>{sourceImages.length} 张 · 可离线阅读</small></span></div>}</div></section>}</aside>
    </div>
    {diagramOpen && <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) setDiagramOpen(false); }}><section className="diagram-modal" role="dialog" aria-modal="true"><header className="diagram-modal-header"><div className="diagram-modal-title-row"><div><span className="eyebrow">SMART DIAGRAM</span><h2>{diagram.data?.diagram?.diagramLabel || (diagram.data?.status === "generating" ? "正在生成智能图解" : "智能图解")}</h2></div><div className="diagram-header-actions">{diagram.data?.status === "ready" && <button className="button button-secondary" disabled={generateDiagram.isPending} onClick={() => generateDiagram.mutate(true)}><RefreshCw className={generateDiagram.isPending ? "spin" : ""} size={16} />{generateDiagram.isPending ? "正在提交…" : "重新生成"}</button>}<button className="button button-secondary" onClick={() => setDiagramOpen(false)}>关闭</button></div></div><p>{diagram.data?.generation?.message || diagram.data?.diagram?.selectionReason || "AI 会先判断资料结构，再选择适合的图形；生成结果会缓存到当前内容。"}</p></header>{diagram.isLoading ? <LoadingState label="正在读取图解状态" /> : diagram.data?.status === "ready" && diagram.data.diagram ? <KnowledgeDiagram diagram={diagram.data.diagram} /> : diagram.data?.status === "generating" ? <section className="diagram-progress" role="status" aria-live="polite"><div className="diagram-progress-orbit"><RefreshCw className="spin" size={25} /></div><div><strong>{diagram.data.generation?.phase === "saving" ? "正在保存图解" : "正在分析与绘制"}</strong><p>{diagram.data.generation?.message}</p><span>已处理 {diagramElapsedLabel} · 可放心关闭窗口，任务会在后台继续</span></div><ol><li className="done">已接收生成任务</li><li className={diagram.data.generation?.phase === "analyzing" ? "active" : "done"}>分析内容并选择图形</li><li className={diagram.data.generation?.phase === "saving" ? "active" : ""}>保存图解结果</li></ol></section> : diagram.data?.status === "failed" ? <EmptyState icon={<Network size={28} />} title="图解生成未完成" description={diagram.data.generation?.error || "生成过程中遇到问题，可重新尝试。"} action={<button className="button button-primary" disabled={generateDiagram.isPending} onClick={() => generateDiagram.mutate(false)}>{generateDiagram.isPending ? "正在重新提交…" : "重新尝试"}</button>} /> : <EmptyState icon={<Network size={28} />} title="尚未生成智能图解" description="需要查看时再调用 AI，系统会根据层级、流程、时序、状态、对比或关系自动选择图形。" action={<button className="button button-primary" disabled={generateDiagram.isPending} onClick={() => generateDiagram.mutate(false)}>{generateDiagram.isPending ? "正在提交任务…" : "生成智能图解"}</button>} />}</section></div>}
  </main>;
}
