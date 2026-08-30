import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, BookOpen, Clock3, FileSearch, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { KnowledgeFacets, MessageItem } from "../types";
import { formatDate, formatLabels } from "./ui";

type SearchMatch = MessageItem & { excerpt: string; relevance: number; matchedBy: string[]; matchReasons: string[] };
type SearchResult = {
  answer: string;
  interpretation: string;
  mode: string;
  resultCount: number;
  matches: SearchMatch[];
  retrieval?: { queries: string[]; filters: Record<string, unknown> };
};
type Props = { open: boolean; onClose: () => void };

const scopeOptions = [
  { value: "all", label: "全部内容", note: "跨收件与知识库" },
  { value: "knowledge", label: "已整理知识", note: "适合查阅与问答" },
  { value: "inbox", label: "待整理收件", note: "查找刚保存的内容" },
] as const;

export default function SearchDialog({ open, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<(typeof scopeOptions)[number]["value"]>("all");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const facets = useQuery({
    queryKey: ["knowledge-facets", "search-suggestions"],
    queryFn: () => api<KnowledgeFacets>("/api/knowledge/facets?organized=1&limit=8"),
    enabled: open,
    staleTime: 30_000,
  });
  const suggestions = useMemo(() => {
    const values = [
      ...(facets.data?.knowledgePoints || []).slice(0, 2).map((item) => `查找关于${item.name}的资料`),
      ...(facets.data?.tools || []).slice(0, 2).map((item) => `我保存过哪些${item.name}相关内容？`),
      ...(facets.data?.domains || []).slice(0, 2).map((item) => `最近收藏的${item.name}内容`),
    ];
    return Array.from(new Set(values)).slice(0, 4);
  }, [facets.data]);

  useEffect(() => {
    if (!open) { setResult(null); setError(""); setBusy(false); }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, open]);
  if (!open) return null;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const value = question.trim();
    if (!value || busy) return;
    setBusy(true); setError("");
    try {
      setResult(await api<SearchResult>("/api/inbox/query", { method: "POST", body: JSON.stringify({ question: value, filters: { scope } }) }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "检索失败");
    } finally { setBusy(false); }
  }

  function openQuestion() {
    const value = question.trim();
    onClose();
    navigate(`/knowledge-chat${value ? `?question=${encodeURIComponent(value)}` : ""}`);
  }

  return <div className="modal-layer search-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="search-modal search-command" role="dialog" aria-modal="true" aria-labelledby="knowledge-search-title">
      <header className="search-command-header"><div><span className="eyebrow"><Sparkles size={14} /> 智能检索</span><h2 id="knowledge-search-title">找到你曾经保存的内容</h2><p>支持标题、正文、主题、知识点、工具和时间范围。</p></div><button className="icon-button" onClick={onClose} aria-label="关闭检索"><X size={20} /></button></header>
      <form className="search-form search-command-form" onSubmit={submit}><Search size={21} /><input autoFocus value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="描述你记得的主题、观点、工具或使用场景" />{question ? <button className="search-clear" type="button" aria-label="清空检索内容" onClick={() => { setQuestion(""); setResult(null); }}><X size={17} /></button> : null}<button className="button button-primary" disabled={busy || !question.trim()}>{busy ? "正在检索…" : "搜索"}</button></form>
      <div className="search-scope" aria-label="检索范围">{scopeOptions.map((item) => <button key={item.value} className={scope === item.value ? "active" : ""} onClick={() => { setScope(item.value); setResult(null); }}><span>{item.label}</span><small>{item.note}</small></button>)}</div>
      {!result && !error ? <div className="search-discovery"><div className="search-discovery-title"><div><Clock3 size={16} /><strong>从你的知识中推荐</strong></div><span>随知识库动态变化</span></div><div className="search-suggestion-list">{suggestions.length ? suggestions.map((item) => <button key={item} onClick={() => setQuestion(item)}><Search size={15} />{item}<ArrowRight size={14} /></button>) : <span className="search-suggestion-placeholder">整理内容后，这里会显示你的高频知识点和主题。</span>}</div></div> : null}
      {error ? <div className="search-error"><FileSearch size={20} /><div><strong>这次检索没有完成</strong><span>{error}</span></div><button onClick={() => void submit()}>重试</button></div> : null}
      {result ? <div className="search-results"><div className="search-summary"><span><Sparkles size={17} /></span><div><strong>{result.interpretation || `找到 ${result.resultCount} 条相关内容`}</strong><p>{result.answer}</p></div>{result.resultCount > 0 ? <button onClick={openQuestion}><Sparkles size={15} />基于结果提问</button> : null}</div><div className="search-result-meta"><span><SlidersHorizontal size={14} />按相关度排序</span><span>{result.resultCount} 条结果</span></div>{result.matches.length ? <div className="search-result-list">{result.matches.map((item) => <button key={item.id} onClick={() => { navigate(`/reader/${encodeURIComponent(item.id)}`); onClose(); }}><div className="search-result-icon"><BookOpen size={18} /></div><div className="search-result-copy"><div><strong>{item.title}</strong><span>{item.relevance}% 相关</span></div><p>{item.excerpt}</p><footer><span>{formatLabels[item.contentFormat] || item.contentFormat}</span><time>{formatDate(item.receivedAt).slice(0, 10)}</time>{item.matchReasons.map((reason) => <b key={reason}>{reason}</b>)}</footer></div><ArrowUpRight size={17} /></button>)}</div> : <div className="search-empty"><FileSearch size={26} /><strong>没有找到匹配内容</strong><p>试试减少限定词，或者切换到“全部内容”。</p></div>}</div> : null}
      <footer className="search-command-footer"><span><kbd>Enter</kbd> 搜索</span><span><kbd>Esc</kbd> 关闭</span><button onClick={openQuestion}>前往知识问答 <ArrowRight size={14} /></button></footer>
    </section>
  </div>;
}
