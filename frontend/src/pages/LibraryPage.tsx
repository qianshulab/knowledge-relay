import { useDeferredValue, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Filter, LayoutGrid, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, attachmentUrl } from "../api";
import type { KnowledgeFacets, MessageItem } from "../types";
import { EmptyState, LoadingState, PageHeader, formatDate, formatLabels } from "../components/ui";

type MessageResponse = { messages: MessageItem[]; pagination: { total: number; hasMore: boolean; nextBefore?: number } };

export default function LibraryPage() {
  const navigate = useNavigate();
  const [format, setFormat] = useState("");
  const [domain, setDomain] = useState("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const facets = useQuery({ queryKey: ["knowledge-facets"], queryFn: () => api<KnowledgeFacets>("/api/knowledge/facets?organized=1&limit=24") });
  const query = useQuery({
    queryKey: ["library", format, domain, deferredSearch],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100", organized: "1" });
      if (format) params.set("format", format);
      if (domain) params.set("domain", domain);
      if (deferredSearch) params.set("q", deferredSearch);
      return api<MessageResponse>(`/api/messages?${params.toString()}`);
    },
  });
  const items = query.data?.messages || [];

  return <main className="page library-page">
    <PageHeader eyebrow="KNOWLEDGE LIBRARY" title="知识库" description="AI 整理完成的内容会按主题和内容形态汇聚在这里，随时可查阅与检索。" />
    <section className="library-toolbar panel"><label className="library-search"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="按标题、摘要或主题筛选" /></label><div className="toolbar-count"><LayoutGrid size={17} />{query.data?.pagination.total ?? 0} 篇内容</div></section>
    <section className="library-layout">
      <aside className="filter-panel panel"><div className="filter-title"><Filter size={18} /><strong>内容导航</strong></div><div className="filter-group"><span>内容形态</span><button className={!format ? "active" : ""} onClick={() => setFormat("")}>全部内容 <small>{facets.data?.total ?? 0}</small></button>{facets.data?.categories.map((item) => <button key={item.name} className={format === item.name ? "active" : ""} onClick={() => setFormat(item.name)}>{formatLabels[item.name] || item.name} <small>{item.count}</small></button>)}</div><div className="filter-group"><span>热门主题</span><button className={!domain ? "active" : ""} onClick={() => setDomain("")}>全部主题</button>{facets.data?.domains.slice(0, 12).map((item) => <button key={item.name} className={domain === item.name ? "active" : ""} onClick={() => setDomain(item.name)}>{item.name} <small>{item.count}</small></button>)}</div></aside>
      <div>{query.isLoading ? <LoadingState label="正在加载知识库" /> : query.isError ? <EmptyState icon={<BookOpen size={28} />} title="知识库加载失败" description={query.error instanceof Error ? query.error.message : "暂时无法读取知识库内容。"} action={<button className="button button-secondary" onClick={() => void query.refetch()}>重新加载</button>} /> : items.length ? <div className="library-grid">{items.map((item) => <article className="knowledge-card" key={item.id} onClick={() => navigate(`/reader/${encodeURIComponent(item.id)}`)}>{item.coverAttachmentId ? <img src={attachmentUrl(item.coverAttachmentId)} alt="" /> : <div className="knowledge-cover"><BookOpen size={28} /><span>{item.domains[0] || formatLabels[item.contentFormat] || "个人知识"}</span></div>}<div className="knowledge-card-body"><div className="knowledge-meta"><span>{formatLabels[item.contentFormat] || item.category}</span><time>{formatDate(item.receivedAt).slice(0, 10)}</time></div><h2>{item.title}</h2><p>{item.summary || "暂无摘要"}</p><div className="tag-row">{(item.domains.length ? item.domains : item.tags).slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div><div className="card-link">阅读全文 <ArrowRight size={16} /></div></div></article>)}</div> : <EmptyState icon={<BookOpen size={28} />} title="没有符合条件的内容" description="请清除搜索或筛选条件后重试。" />}</div>
    </section>
  </main>;
}
