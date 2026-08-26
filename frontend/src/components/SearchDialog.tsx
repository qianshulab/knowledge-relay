import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, Search, Sparkles, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import type { MessageItem } from "../types";

type SearchResult = { answer: string; interpretation: string; mode: string; matches: (MessageItem & { excerpt: string })[] };
type Props = { open: boolean; onClose: () => void };

export default function SearchDialog({ open, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<"all" | "inbox" | "knowledge">("all");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => { if (!open) { setResult(null); setError(""); } }, [open]);
  if (!open) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    setBusy(true); setError("");
    try {
      setResult(await api<SearchResult>("/api/inbox/query", { method: "POST", body: JSON.stringify({ question, filters: { scope } }) }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "检索失败");
    } finally { setBusy(false); }
  }

  return <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="search-modal" role="dialog" aria-modal="true" aria-label="检索个人知识">
      <header><div><span className="eyebrow"><Sparkles size={14} /> Semantic retrieval</span><h2>检索个人知识</h2></div><button className="icon-button" onClick={onClose}><X size={20} /></button></header>
      <form className="search-form" onSubmit={submit}><Search size={20} /><input autoFocus value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="描述你记得的主题、观点、工具或使用场景" /><button className="button button-primary" disabled={busy}>{busy ? "理解中…" : "开始检索"}</button></form>
      <div className="segmented-control" aria-label="检索范围">
        {([['all','全部内容'],['inbox','待整理收件'],['knowledge','已整理知识']] as const).map(([value,label]) => <button key={value} className={scope === value ? "active" : ""} onClick={() => setScope(value)}>{label}</button>)}
      </div>
      {!result && !error && <div className="search-guidance"><strong>可以这样搜索</strong><div><button onClick={() => setQuestion("最近保存过哪些关于 AI Agent 的实践？")}>AI Agent 实践</button><button onClick={() => setQuestion("我之前收藏的 NAS 工具有哪些？")}>NAS 工具</button><button onClick={() => setQuestion("最近 7 天有哪些需要继续研究的内容？")}>最近 7 天待研究</button></div></div>}
      {error && <div className="inline-alert danger">{error}</div>}
      {result && <div className="search-results">
        <div className="search-answer"><Sparkles size={18} /><p>{result.answer}</p></div>
        <div className="search-result-list">{result.matches.map((item) => <button key={item.id} onClick={() => { navigate(`/reader/${encodeURIComponent(item.id)}`); onClose(); }}><div><strong>{item.title}</strong><p>{item.excerpt}</p><span>{item.domains.slice(0, 3).join(" · ") || item.contentFormat}</span></div><ArrowUpRight size={18} /></button>)}</div>
      </div>}
    </section>
  </div>;
}
