import { useEffect, useState } from "react";
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

type DiagramResponse = { status: "ready" | "not_generated"; cached: boolean; diagram?: KnowledgeMap };

export default function ReaderPage() {
  const { id = "" } = useParams();
  const messageId = decodeURIComponent(id);
  const navigate = useNavigate();
  const { notify } = useApp();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"article" | "notes" | "details" | "original">("article");
  const [diagramOpen, setDiagramOpen] = useState(false);
  const detail = useQuery({ queryKey: ["message", messageId], queryFn: () => api<MessageDetail>(`/api/messages/${encodeURIComponent(messageId)}`), enabled: Boolean(messageId), refetchInterval: (query) => ["processing", "pending", "queued"].includes(query.state.data?.agentStatus || "") ? 3000 : false });
  const articleAttachment = detail.data?.attachments.find((attachment) => attachment.kind === "derived" && attachment.mimeType === "text/markdown");
  const articleSnapshot = useQuery({
    queryKey: ["article-markdown", messageId, articleAttachment?.id],
    queryFn: () => api<string>(attachmentUrl(articleAttachment!.id)),
    enabled: Boolean(articleAttachment?.id),
    staleTime: Infinity,
  });
  const diagram = useQuery({ queryKey: ["diagram", messageId], queryFn: () => api<DiagramResponse>(`/api/messages/${encodeURIComponent(messageId)}/diagram`), enabled: diagramOpen });
  const reprocess = useMutation({ mutationFn: () => api(`/api/messages/${encodeURIComponent(messageId)}/reprocess`, { method: "POST" }), onSuccess: () => { notify("已加入重新整理队列", "success"); void queryClient.invalidateQueries({ queryKey: ["message", messageId] }); } });
  const generateDiagram = useMutation({ mutationFn: () => api<DiagramResponse>(`/api/messages/${encodeURIComponent(messageId)}/diagram`, { method: "POST", body: JSON.stringify({}) }), onSuccess: (data) => { queryClient.setQueryData(["diagram", messageId], data); notify("智能图解已生成", "success"); }, onError: (error) => notify(error instanceof Error ? error.message : "图解生成失败", "danger") });

  useEffect(() => { if (detail.data && !detail.data.readAt) void api(`/api/messages/${encodeURIComponent(messageId)}/library`, { method: "PATCH", body: JSON.stringify({ read: true }) }); }, [detail.data, messageId]);

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
    <header className="reader-hero"><button className="back-link" onClick={() => navigate(-1)}><ArrowLeft size={18} />返回</button><div className="reader-title-wrap"><span className="eyebrow">KNOWLEDGE READING</span><h1>{item.title}</h1><div className="reader-meta"><span>{formatLabels[item.contentFormat] || item.category}</span>{item.domains.slice(0, 2).map((value) => <span key={value}>{value}</span>)}<span>{item.source?.name || "收件内容"}</span><time>{formatDate(item.receivedAt).slice(0, 10)}</time></div></div><div className="reader-actions"><button className="button button-secondary" onClick={() => void changeState(item.libraryState === "archived" ? "inbox" : "archived")}><Archive size={17} />{item.libraryState === "archived" ? "恢复到收件台" : "归档"}</button><button className="button button-secondary" onClick={() => setDiagramOpen(true)}><Network size={17} />智能图解</button><button className="button button-secondary" disabled={reprocess.isPending} onClick={() => reprocess.mutate()}><RefreshCw size={17} />{reprocess.isPending ? "已提交" : "重新整理"}</button><button className="button button-danger" onClick={() => void remove()}><Trash2 size={17} />永久删除</button></div></header>
    <div className="reader-layout"><article className="reader-paper"><nav className="reader-tabs">{([['article','文章正文'],['notes','整理笔记'],['details','延伸整理'],['original','原始内容']] as const).map(([value, label]) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>)}</nav><div className="prose">{tab === "article" ? articleAttachment && articleSnapshot.isLoading ? <LoadingState label="正在还原原文版式" /> : <Markdown>{article}</Markdown> : tab === "notes" ? <><h2>内容摘要</h2><p>{item.summary || "暂无摘要"}</p>{item.keyPoints.length > 0 && <><h2>核心要点</h2><ul>{item.keyPoints.map((point) => <li key={point}>{point}</li>)}</ul></>}</> : tab === "details" ? <Markdown>{item.detailsMarkdown || "暂无延伸整理内容。"}</Markdown> : <pre className="original-text">{item.text}</pre>}{tab === "article" && showStandaloneImages && sourceImages.map((image) => <img key={image.id} src={attachmentUrl(image.id)} alt={image.fileName} loading="lazy" />)}</div></article>
      <aside className="reader-aside"><section className="aside-card"><h2>AI 摘要</h2><p>{item.summary || "等待整理后生成摘要。"}</p>{item.source?.url && <a href={item.source.url} target="_blank" rel="noreferrer">查看原始网页 ↗</a>}</section><section className="aside-card"><h2>知识索引</h2><div className="aside-facts"><div><span>内容形态</span><strong>{formatLabels[item.contentFormat] || item.category}</strong></div><div><span>整理状态</span><strong>{item.agentStatus === "completed" ? "已整理" : item.agentStatus}</strong></div><div><span>置信度</span><strong>{item.confidence || "—"}</strong></div></div><div className="tag-row">{[...item.domains, ...item.knowledgePoints, ...item.tools].slice(0, 10).map((value) => <span key={value}>{value}</span>)}</div></section>{item.attachments.length > 0 && <section className="aside-card"><h2>内容资产</h2><div className="asset-list">{files.map((file) => <a key={file.id} href={`${attachmentUrl(file.id)}?download=1`}><FileText size={18} /><span><strong>{file.fileName}</strong><small>{formatBytes(file.size)}</small></span><Download size={17} /></a>)}{sourceImages.length > 0 && <div className="asset-summary"><ImageIcon size={18} /><span><strong>正文图片已本地保存</strong><small>{sourceImages.length} 张 · 可离线阅读</small></span></div>}</div></section>}</aside>
    </div>
    {diagramOpen && <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) setDiagramOpen(false); }}><section className="diagram-modal" role="dialog" aria-modal="true"><header><div><span className="eyebrow">SMART DIAGRAM</span><h2>{diagram.data?.diagram?.diagramLabel || "智能图解"}</h2><p>根据当前资料生成并保存，下次打开无需重复生成。</p></div><button className="button button-secondary" onClick={() => setDiagramOpen(false)}>关闭</button></header>{diagram.isLoading ? <LoadingState label="正在读取图解" /> : diagram.data?.diagram ? <KnowledgeDiagram diagram={diagram.data.diagram} /> : <EmptyState icon={<Network size={28} />} title="尚未生成智能图解" description="仅在需要时调用 AI 生成，结果会保存在当前内容中。" action={<button className="button button-primary" disabled={generateDiagram.isPending} onClick={() => generateDiagram.mutate()}>{generateDiagram.isPending ? "正在生成…" : "生成智能图解"}</button>} />}</section></div>}
  </main>;
}
