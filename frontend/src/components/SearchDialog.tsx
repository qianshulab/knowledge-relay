import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, BookOpen, Clock3, FileSearch, Search, SlidersHorizontal, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { KnowledgeFacets, MessageItem } from "../types";
import { formatDate, formatLabels } from "./ui";

type SearchMatch = MessageItem & { excerpt: string; relevance: number; matchReasons?: string[] };
type SearchResult = {
  interpretation: string;
  resultCount: number;
  matches: SearchMatch[];
};
type Props = { open: boolean; onClose: () => void };

const scopeOptions = [
  { value: "all", label: "全部内容", note: "跨收件与知识库" },
  { value: "knowledge", label: "已整理知识", note: "定位已整理的资料" },
  { value: "inbox", label: "待整理收件", note: "查找刚保存的内容" },
] as const;

export default function SearchDialog({ open, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<(typeof scopeOptions)[number]["value"]>("all");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const restoreFocus = useRef(true);
  const activeRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  onCloseRef.current = onClose;
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
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    restoreFocus.current = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ) || []).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
      requestSequence.current += 1;
      setBusy(false);
      setResult(null);
      setError("");
      setSubmittedQuestion("");
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      if (restoreFocus.current) window.requestAnimationFrame(() => previouslyFocused?.focus());
    };
  }, [open]);
  if (!open) return null;

  function resetSearchState() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    requestSequence.current += 1;
    setBusy(false);
    setResult(null);
    setError("");
    setSubmittedQuestion("");
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const value = question.trim();
    if (!value || busy) return;
    activeRequest.current?.abort();
    const controller = new AbortController();
    const requestId = ++requestSequence.current;
    activeRequest.current = controller;
    setBusy(true);
    setResult(null);
    setError("");
    setSubmittedQuestion(value);
    try {
      const response = await api<SearchResult>("/api/inbox/query", {
        method: "POST",
        body: JSON.stringify({ question: value, filters: { scope } }),
        signal: controller.signal,
      });
      if (requestId === requestSequence.current) setResult(response);
    } catch (reason) {
      if (!controller.signal.aborted && requestId === requestSequence.current) {
        setError(reason instanceof Error ? reason.message : "检索失败");
      }
    } finally {
      if (requestId === requestSequence.current) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  }

  function openQuestion() {
    const value = question.trim();
    restoreFocus.current = false;
    onClose();
    navigate(`/knowledge-chat${value ? `?question=${encodeURIComponent(value)}` : ""}`);
  }

  return <div className="modal-layer search-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="search-modal search-command" role="dialog" aria-modal="true" aria-labelledby="knowledge-search-title">
      <header className="search-command-header"><div><span className="eyebrow"><Search size={14} /> 个人知识检索</span><h2 id="knowledge-search-title">找回你保存过的资料</h2><p>检索负责定位原文，不代替知识问答生成结论。</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭检索"><X size={20} /></button></header>
      <form className="search-form search-command-form" onSubmit={submit} aria-busy={busy}><Search size={21} /><input autoFocus value={question} onChange={(event) => { resetSearchState(); setQuestion(event.target.value); }} placeholder="输入记得的标题、观点、工具或使用场景" aria-label="检索个人知识" />{question ? <button className="search-clear" type="button" aria-label="清空检索内容" onClick={() => { resetSearchState(); setQuestion(""); }}><X size={17} /></button> : null}<button type="submit" className="button button-primary" disabled={busy || !question.trim()}>{busy ? "正在检索…" : "搜索资料"}</button></form>
      <div className="search-scope" aria-label="检索范围">{scopeOptions.map((item) => <button type="button" key={item.value} className={scope === item.value ? "active" : ""} aria-pressed={scope === item.value} disabled={busy} onClick={() => { resetSearchState(); setScope(item.value); }}><span>{item.label}</span><small>{item.note}</small></button>)}</div>
      {!result && !error ? <div className="search-discovery"><div className="search-discovery-title"><div><Clock3 size={16} /><strong>从你的知识中推荐</strong></div><span>随知识库动态变化</span></div><div className="search-suggestion-list">{facets.isPending || (facets.isFetching && !facets.data) ? <span className="search-suggestion-placeholder" role="status">正在读取常用主题…</span> : facets.isError && !facets.data ? <span className="search-suggestion-placeholder" role="alert">暂时无法读取推荐词。<button type="button" className="text-link" disabled={facets.isFetching} onClick={() => void facets.refetch()}>{facets.isFetching ? "重试中…" : "重试"}</button></span> : suggestions.length ? suggestions.map((item) => <button type="button" key={item} onClick={() => { resetSearchState(); setQuestion(item); }}><Search size={15} />{item}<ArrowRight size={14} /></button>) : <span className="search-suggestion-placeholder">整理内容后，这里会显示你的高频知识点和主题。</span>}</div></div> : null}
      {error ? <div className="search-error" role="alert"><FileSearch size={20} /><div><strong>这次检索没有完成</strong><span>{error}</span></div><button type="button" onClick={() => void submit()}>重试</button></div> : null}
      {result ? <div className="search-results" aria-live="polite"><div className="search-summary"><span><FileSearch size={17} /></span><div><strong>{result.interpretation || `“${submittedQuestion}”的检索结果`}</strong><p>已按标题、正文和知识索引的相关度排列，打开资料即可查看完整原文。</p></div></div><div className="search-result-meta"><span><SlidersHorizontal size={14} />按相关度排序</span><span>{result.resultCount} 条结果</span></div>{result.matches.length ? <div className="search-result-list">{result.matches.map((item) => <button type="button" key={item.id} onClick={() => { restoreFocus.current = false; navigate(`/reader/${encodeURIComponent(item.id)}`); onClose(); }}><div className="search-result-icon"><BookOpen size={18} /></div><div className="search-result-copy"><div><strong>{item.title}</strong><span>{item.relevance}% 相关</span></div><p>{item.excerpt}</p><footer><span>{formatLabels[item.contentFormat] || item.contentFormat}</span><time>{formatDate(item.receivedAt).slice(0, 10)}</time>{(item.matchReasons || []).map((reason) => <b key={reason}>{reason}</b>)}</footer></div><ArrowUpRight size={17} /></button>)}</div> : <div className="search-empty"><FileSearch size={26} /><strong>没有找到匹配内容</strong><p>试试减少限定词，或者切换到“全部内容”。</p></div>}</div> : null}
      <footer className="search-command-footer"><span><kbd>Enter</kbd> 搜索</span><span><kbd>Esc</kbd> 关闭</span><button type="button" onClick={openQuestion}>需要归纳、比较或追问？进入知识问答 <ArrowRight size={14} /></button></footer>
    </section>
  </div>;
}
