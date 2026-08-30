import { useDeferredValue, useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, BookmarkPlus, Filter, FolderHeart, Heart, LayoutGrid, List, Pin, Search, Trash2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, attachmentUrl } from "../api";
import type { KnowledgeFacets, MessageItem, SmartCollection, SmartCollectionRules } from "../types";
import { useApp } from "../App";
import { EmptyState, LoadingState, PageHeader, formatDate, formatLabels } from "../components/ui";

type MessageResponse = { messages: MessageItem[]; pagination: { total: number; hasMore: boolean; nextBefore?: number } };

const coverThemes = [
  ["#0f766e", "#134e4a", "#5eead4"],
  ["#315c8c", "#1e3a5f", "#93c5fd"],
  ["#6d4ca3", "#443164", "#c4b5fd"],
  ["#9a5b2b", "#5f381f", "#fdba74"],
  ["#3f6f57", "#234536", "#86efac"],
  ["#8b4b63", "#542d3d", "#f9a8d4"],
] as const;

function coverTheme(value: string): CSSProperties {
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  const palette = coverThemes[Math.abs(hash) % coverThemes.length]!;
  return {
    "--cover-primary": palette[0],
    "--cover-deep": palette[1],
    "--cover-accent": palette[2],
  } as CSSProperties;
}

function KnowledgeCardCover({ item }: { item: MessageItem }) {
  const [failed, setFailed] = useState(false);
  if (item.coverAttachmentId && !failed) {
    return <img src={attachmentUrl(item.coverAttachmentId)} alt={`${item.title}封面`} loading="lazy" onError={() => setFailed(true)} />;
  }
  const label = item.domains[0] || formatLabels[item.contentFormat] || "个人知识";
  return <div className="knowledge-cover" style={coverTheme(`${item.id}:${label}`)} role="img" aria-label={`${label}默认封面`}>
    <span className="knowledge-cover-orbit" aria-hidden="true"><i /><i /><i /></span>
    <span className="knowledge-cover-brand"><b>知流</b><small>KNOWLEDGE RELAY</small></span>
    <strong>{label}</strong>
  </div>;
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useApp();
  const [format, setFormat] = useState("");
  const [domain, setDomain] = useState("");
  const [knowledgePoint, setKnowledgePoint] = useState("");
  const [tool, setTool] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [unread, setUnread] = useState(false);
  const [search, setSearch] = useState("");
  const [activeCollection, setActiveCollection] = useState("");
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
    try { return window.localStorage.getItem("knowledge-relay-library-view") === "list" ? "list" : "grid"; } catch { return "grid"; }
  });
  const deferredSearch = useDeferredValue(search.trim());

  const clearFilters = () => {
    setFormat("");
    setDomain("");
    setKnowledgePoint("");
    setTool("");
    setFavorite(false);
    setUnread(false);
    setSearch("");
    setActiveCollection("");
  };

  const selectFormat = (nextFormat: string) => {
    setFormat((current) => current === nextFormat ? "" : nextFormat);
    setDomain("");
    setKnowledgePoint("");
    setTool("");
    setSearch("");
    setFavorite(false); setUnread(false); setActiveCollection("");
  };

  const selectDomain = (nextDomain: string) => {
    setDomain((current) => current === nextDomain ? "" : nextDomain);
    setFormat("");
    setKnowledgePoint("");
    setTool("");
    setSearch("");
    setFavorite(false); setUnread(false); setActiveCollection("");
  };

  const selectKnowledgePoint = (value: string) => {
    setKnowledgePoint((current) => current === value ? "" : value);
    setFormat(""); setDomain(""); setTool(""); setSearch(""); setFavorite(false); setUnread(false); setActiveCollection("");
  };

  const selectTool = (value: string) => {
    setTool((current) => current === value ? "" : value);
    setFormat(""); setDomain(""); setKnowledgePoint(""); setSearch(""); setFavorite(false); setUnread(false); setActiveCollection("");
  };

  const changeView = (value: "grid" | "list") => {
    setViewMode(value);
    try { window.localStorage.setItem("knowledge-relay-library-view", value); } catch { /* keep view switching available */ }
  };

  const facets = useQuery({
    queryKey: ["knowledge-facets"],
    queryFn: () => api<KnowledgeFacets>("/api/knowledge/facets?organized=1&limit=24"),
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 20_000,
  });

  const collections = useQuery({ queryKey: ["smart-collections"], queryFn: () => api<{ collections: SmartCollection[] }>("/api/collections") });
  const createCollection = useMutation({
    mutationFn: (input: { name: string; rules: SmartCollectionRules }) => api<{ collection: SmartCollection }>("/api/collections", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (result) => {
      notify(`已保存智能集合“${result.collection.name}”`, "success");
      setCollectionOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["smart-collections"] });
    },
    onError: (error) => notify(error instanceof Error ? error.message : "集合保存失败", "danger"),
  });
  const deleteCollection = useMutation({
    mutationFn: (id: string) => api(`/api/collections/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => { setActiveCollection(""); notify("集合已删除", "success"); void queryClient.invalidateQueries({ queryKey: ["smart-collections"] }); },
  });

  const query = useQuery({
    queryKey: ["library", format, domain, knowledgePoint, tool, favorite, unread, deferredSearch],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100", organized: "1" });
      if (format) params.set("format", format);
      if (domain) params.set("domain", domain);
      if (knowledgePoint) params.set("knowledgePoint", knowledgePoint);
      if (tool) params.set("tool", tool);
      if (favorite) params.set("favorite", "1");
      if (unread) params.set("unread", "1");
      if (deferredSearch) params.set("q", deferredSearch);
      return api<MessageResponse>(`/api/messages?${params.toString()}`);
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 20_000,
  });

  const items = query.data?.messages || [];
  const hasFilters = Boolean(format || domain || knowledgePoint || tool || favorite || unread || search.trim());
  const activeFilter = collections.data?.collections.find((item) => item.id === activeCollection)?.name || (format ? (formatLabels[format] || format) : domain || knowledgePoint || tool || (favorite ? "重点收藏" : unread ? "尚未阅读" : ""));

  function applyCollection(collection: SmartCollection) {
    const rules = collection.rules;
    setFormat(rules.format || ""); setDomain(rules.domain || ""); setKnowledgePoint(rules.knowledgePoint || "");
    setTool(rules.tool || ""); setFavorite(Boolean(rules.favorite)); setUnread(Boolean(rules.unread)); setSearch(rules.query || "");
    setActiveCollection(collection.id);
  }

  function saveCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    createCollection.mutate({
      name: String(data.get("name") || ""),
      rules: { ...(format ? { format: format as SmartCollectionRules["format"] } : {}), ...(domain ? { domain } : {}), ...(knowledgePoint ? { knowledgePoint } : {}), ...(tool ? { tool } : {}), ...(favorite ? { favorite: true } : {}), ...(unread ? { unread: true } : {}), ...(search.trim() ? { query: search.trim() } : {}) },
    });
  }

  return <main className="page library-page">
    <PageHeader eyebrow="KNOWLEDGE LIBRARY" title="知识库" description="AI 整理完成的内容会按主题和内容形态汇聚在这里，随时可查阅与检索。" />
    <section className="library-toolbar panel">
      <label className="library-search"><Search size={18} /><input value={search} onChange={(event) => { setSearch(event.target.value); setActiveCollection(""); }} placeholder="按标题、摘要或主题筛选" /></label>
      <button className={`library-quick-filter ${favorite ? "active" : ""}`} onClick={() => { setFavorite(!favorite); setActiveCollection(""); }}><Heart size={15} />重点</button>
      <button className={`library-quick-filter ${unread ? "active" : ""}`} onClick={() => { setUnread(!unread); setActiveCollection(""); }}>未读</button>
      {hasFilters ? <button className="library-clear" onClick={clearFilters}><X size={15} />清除筛选</button> : null}
      <div className="library-view-tools">{hasFilters && <button className="save-view-button" onClick={() => setCollectionOpen(true)}><BookmarkPlus size={15} />保存视图</button>}<span>{query.data?.pagination.total ?? 0} 篇内容</span><div className="view-switch" aria-label="内容视图"><button className={viewMode === "grid" ? "active" : ""} onClick={() => changeView("grid")} aria-label="卡片视图"><LayoutGrid size={16} /></button><button className={viewMode === "list" ? "active" : ""} onClick={() => changeView("list")} aria-label="列表视图"><List size={16} /></button></div></div>
    </section>
    <section className="library-layout">
      <aside className="filter-panel panel">
        <div className="filter-title"><Filter size={18} /><strong>内容导航</strong></div>
        <div className="filter-group collection-filter-group"><span>我的集合</span>
          {collections.data?.collections.length ? collections.data.collections.map((collection) => <div className={`collection-filter ${activeCollection === collection.id ? "active" : ""}`} key={collection.id}><button onClick={() => applyCollection(collection)}><FolderHeart size={15} />{collection.name}<small>{collection.itemCount}</small></button><button className="collection-delete" aria-label={`删除集合${collection.name}`} onClick={() => { if (window.confirm(`删除集合“${collection.name}”？内容本身不会被删除。`)) deleteCollection.mutate(collection.id); }}><Trash2 size={13} /></button></div>) : <p className="filter-hint">筛选后可保存为自动更新的集合。</p>}
          <button className="collection-create-link" onClick={() => setCollectionOpen(true)}><Pin size={14} />新建集合</button>
        </div>
        <div className="filter-group">
          <span>内容形态</span>
          <button className={!format && !domain && !knowledgePoint && !tool ? "active" : ""} onClick={clearFilters}>全部内容 <small>{facets.data?.total ?? 0}</small></button>
          {facets.data?.categories.map((item) => <button key={item.name} className={format === item.name ? "active" : ""} onClick={() => selectFormat(item.name)}>{formatLabels[item.name] || item.name} <small>{item.count}</small></button>)}
        </div>
        <div className="filter-group">
          <span>热门主题</span>
          {facets.data?.domains.slice(0, 12).map((item) => <button key={item.name} className={domain === item.name ? "active" : ""} onClick={() => selectDomain(item.name)}>{item.name} <small>{item.count}</small></button>)}
        </div>
        <div className="filter-group">
          <span>知识点</span>
          {facets.data?.knowledgePoints.slice(0, 10).map((item) => <button key={item.name} className={knowledgePoint === item.name ? "active" : ""} onClick={() => selectKnowledgePoint(item.name)}>{item.name} <small>{item.count}</small></button>)}
        </div>
        <div className="filter-group">
          <span>工具与平台</span>
          {facets.data?.tools.slice(0, 8).map((item) => <button key={item.name} className={tool === item.name ? "active" : ""} onClick={() => selectTool(item.name)}>{item.name} <small>{item.count}</small></button>)}
        </div>
      </aside>
      <div>
        {activeFilter ? <div className="library-active-filter"><span>当前浏览</span><strong>{activeFilter}</strong></div> : null}
        {query.isLoading ? <LoadingState label="正在加载知识库" /> : query.isError ? <EmptyState icon={<BookOpen size={28} />} title="知识库加载失败" description={query.error instanceof Error ? query.error.message : "暂时无法读取知识库内容。"} action={<button className="button button-secondary" onClick={() => void query.refetch()}>重新加载</button>} /> : items.length ? <div className={`library-grid ${viewMode === "list" ? "library-list" : ""}`}>{items.map((item) => <article className="knowledge-card" key={item.id} onClick={() => navigate(`/reader/${encodeURIComponent(item.id)}`)}><KnowledgeCardCover item={item} /><div className="knowledge-card-body"><div className="knowledge-meta"><span>{formatLabels[item.contentFormat] || item.category}</span><time>{formatDate(item.receivedAt).slice(0, 10)}</time></div><h2>{item.title}</h2><p>{item.summary || "暂无摘要"}</p><div className="tag-row">{(item.domains.length ? item.domains : item.tags).slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div><div className="card-link">阅读全文 <ArrowRight size={16} /></div></div></article>)}</div> : <EmptyState icon={<BookOpen size={28} />} title="没有符合条件的内容" description={hasFilters ? "当前筛选条件下没有内容，可以清除筛选后查看全部知识。" : "整理完成的内容会自动出现在这里。"} action={hasFilters ? <button className="button button-secondary" onClick={clearFilters}>清除筛选并显示全部</button> : undefined} />}
      </div>
    </section>
    {collectionOpen && <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) setCollectionOpen(false); }}><form className="collection-dialog" onSubmit={saveCollection}><div><span className="eyebrow">SMART COLLECTION</span><h2>保存为智能集合</h2><p>当前筛选条件会持续生效，新整理的内容也会自动进入集合。</p></div><label>集合名称<input name="name" autoFocus required maxLength={60} placeholder={activeFilter || "例如：待读的 AI 资料"} /></label><div className="collection-rule-preview"><strong>包含条件</strong><span>{[format && (formatLabels[format] || format), domain, knowledgePoint, tool, favorite && "重点收藏", unread && "尚未阅读", search.trim()].filter(Boolean).join(" · ") || "全部已整理内容"}</span></div><div className="form-actions"><button type="button" className="button button-secondary" onClick={() => setCollectionOpen(false)}>取消</button><button className="button button-primary" disabled={createCollection.isPending}>{createCollection.isPending ? "正在保存…" : "保存集合"}</button></div></form></div>}
  </main>;
}
