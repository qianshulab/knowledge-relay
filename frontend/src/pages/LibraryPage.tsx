import { useDeferredValue, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, BookmarkPlus, Filter, FolderHeart, Heart, LayoutGrid, List, Pin, RefreshCw, Search, Trash2, X } from "lucide-react";
import { Link } from "react-router-dom";
import { api, attachmentUrl } from "../api";
import type { KnowledgeFacets, MessageItem, SmartCollection, SmartCollectionRules } from "../types";
import { useApp } from "../App";
import { useConfirm } from "../components/ConfirmDialog";
import { useModalFocus } from "../components/useModalFocus";
import { EmptyState, InlineMessage, LoadingState, PageHeader, formatDate, formatLabels } from "../components/ui";

type MessageResponse = { messages: MessageItem[]; pagination: { total: number; hasMore: boolean; nextBefore?: number } };
const pageSize = 24;

const coverThemes = [
  ["#5b52d9", "#332b82", "#ff806b"],
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
  const queryClient = useQueryClient();
  const { notify } = useApp();
  const confirm = useConfirm();
  const [format, setFormat] = useState("");
  const [domain, setDomain] = useState("");
  const [knowledgePoint, setKnowledgePoint] = useState("");
  const [tool, setTool] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [unread, setUnread] = useState(false);
  const [search, setSearch] = useState("");
  const [activeCollection, setActiveCollection] = useState("");
  const [collectionOpen, setCollectionOpen] = useState(false);
  const collectionReturnFocusRef = useRef<HTMLElement | null>(null);
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
    setActiveCollection("");
  };

  const selectDomain = (nextDomain: string) => {
    setDomain((current) => current === nextDomain ? "" : nextDomain);
    setActiveCollection("");
  };

  const selectKnowledgePoint = (value: string) => {
    setKnowledgePoint((current) => current === value ? "" : value);
    setActiveCollection("");
  };

  const selectTool = (value: string) => {
    setTool((current) => current === value ? "" : value);
    setActiveCollection("");
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
    onError: (error) => notify(error instanceof Error ? error.message : "集合删除失败，请重试", "danger"),
  });
  const collectionDialogRef = useModalFocus<HTMLFormElement>({
    open: collectionOpen,
    onClose: () => setCollectionOpen(false),
    returnFocusRef: collectionReturnFocusRef,
    canClose: !createCollection.isPending,
  });

  const query = useInfiniteQuery({
    queryKey: ["library", format, domain, knowledgePoint, tool, favorite, unread, deferredSearch],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(pageSize), organized: "1" });
      if (pageParam !== undefined) params.set("before", String(pageParam));
      if (format) params.set("format", format);
      if (domain) params.set("domain", domain);
      if (knowledgePoint) params.set("knowledgePoint", knowledgePoint);
      if (tool) params.set("tool", tool);
      if (favorite) params.set("favorite", "1");
      if (unread) params.set("unread", "1");
      if (deferredSearch) params.set("q", deferredSearch);
      return api<MessageResponse>(`/api/messages?${params.toString()}`);
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.pagination.hasMore ? lastPage.pagination.nextBefore : undefined,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 20_000,
  });

  const items = useMemo(() => {
    const unique = new Map<string, MessageItem>();
    for (const page of query.data?.pages || []) {
      for (const item of page.messages) unique.set(item.id, item);
    }
    return [...unique.values()];
  }, [query.data?.pages]);
  const total = query.data?.pages[0]?.pagination.total ?? 0;
  const hasFilters = Boolean(format || domain || knowledgePoint || tool || favorite || unread || search.trim());
  const activeFilter = collections.data?.collections.find((item) => item.id === activeCollection)?.name || "";
  const activeFilters = [
    ...(format ? [{ key: "format", label: `形态：${formatLabels[format] || format}`, clear: () => { setFormat(""); setActiveCollection(""); } }] : []),
    ...(domain ? [{ key: "domain", label: `主题：${domain}`, clear: () => { setDomain(""); setActiveCollection(""); } }] : []),
    ...(knowledgePoint ? [{ key: "knowledgePoint", label: `知识点：${knowledgePoint}`, clear: () => { setKnowledgePoint(""); setActiveCollection(""); } }] : []),
    ...(tool ? [{ key: "tool", label: `工具：${tool}`, clear: () => { setTool(""); setActiveCollection(""); } }] : []),
    ...(favorite ? [{ key: "favorite", label: "重点内容", clear: () => { setFavorite(false); setActiveCollection(""); } }] : []),
    ...(unread ? [{ key: "unread", label: "尚未阅读", clear: () => { setUnread(false); setActiveCollection(""); } }] : []),
    ...(search.trim() ? [{ key: "search", label: `搜索：${search.trim()}`, clear: () => { setSearch(""); setActiveCollection(""); } }] : []),
  ];

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

  async function confirmDeleteCollection(collection: SmartCollection) {
    const accepted = await confirm({
      title: "删除智能集合？",
      description: `“${collection.name}”只是一组自动筛选条件，删除后不会影响其中的知识内容。`,
      confirmLabel: "删除集合",
      tone: "danger",
    });
    if (accepted) deleteCollection.mutate(collection.id);
  }

  async function loadMore() {
    const result = await query.fetchNextPage();
    if (result.isError) notify(result.error instanceof Error ? result.error.message : "下一页加载失败，请重试", "danger");
  }

  function openCollectionDialog() {
    collectionReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCollectionOpen(true);
  }

  return <main className="page library-page">
    <PageHeader eyebrow="KNOWLEDGE LIBRARY" title="知识库" description="AI 整理完成的内容会按主题和内容形态汇聚在这里，随时可查阅与检索。" />
    {facets.isError || collections.isError ? <InlineMessage tone="warning"><span>部分知识导航暂时无法读取，正文内容仍可正常浏览。</span><button type="button" className="text-link" disabled={facets.isFetching || collections.isFetching} onClick={() => { if (facets.isError) void facets.refetch(); if (collections.isError) void collections.refetch(); }}><RefreshCw className={facets.isFetching || collections.isFetching ? "spin" : ""} size={14} />重新读取导航</button></InlineMessage> : null}
    <section className="library-toolbar panel">
      <label className="library-search"><Search size={18} /><input aria-label="筛选知识库" value={search} onChange={(event) => { setSearch(event.target.value); setActiveCollection(""); }} placeholder="按标题、摘要或主题筛选" /></label>
      <button className={`library-quick-filter ${favorite ? "active" : ""}`} aria-pressed={favorite} onClick={() => { setFavorite(!favorite); setActiveCollection(""); }}><Heart size={15} />重点</button>
      <button className={`library-quick-filter ${unread ? "active" : ""}`} aria-pressed={unread} onClick={() => { setUnread(!unread); setActiveCollection(""); }}>未读</button>
      {hasFilters ? <button className="library-clear" onClick={clearFilters}><X size={15} />清除筛选</button> : null}
      <div className="library-view-tools">{hasFilters && <button className="save-view-button" onClick={openCollectionDialog}><BookmarkPlus size={15} />保存视图</button>}<span>{total} 篇内容</span><div className="view-switch" role="group" aria-label="内容视图"><button className={viewMode === "grid" ? "active" : ""} onClick={() => changeView("grid")} aria-label="卡片视图" aria-pressed={viewMode === "grid"}><LayoutGrid size={16} /></button><button className={viewMode === "list" ? "active" : ""} onClick={() => changeView("list")} aria-label="列表视图" aria-pressed={viewMode === "list"}><List size={16} /></button></div></div>
    </section>
    <section className="library-layout">
      <aside className="filter-panel panel">
        <div className="filter-title"><Filter size={18} /><strong>内容导航</strong></div>
        <div className="filter-group collection-filter-group"><span>我的集合</span>
          {collections.isLoading ? <p className="filter-hint" role="status">正在读取集合…</p> : collections.isError ? <p className="filter-hint">集合暂时不可用，请重新读取导航。</p> : collections.data?.collections.length ? collections.data.collections.map((collection) => <div className={`collection-filter ${activeCollection === collection.id ? "active" : ""}`} key={collection.id}><button onClick={() => applyCollection(collection)} aria-pressed={activeCollection === collection.id}><FolderHeart size={15} />{collection.name}<small>{collection.itemCount}</small></button><button className="collection-delete" disabled={deleteCollection.isPending} aria-label={`删除集合${collection.name}`} onClick={() => void confirmDeleteCollection(collection)}><Trash2 size={13} /></button></div>) : <p className="filter-hint">筛选后可保存为自动更新的集合。</p>}
          <button className="collection-create-link" onClick={openCollectionDialog}><Pin size={14} />新建集合</button>
        </div>
        <div className="filter-group">
          <span>内容形态</span>
          <button className={!hasFilters ? "active" : ""} onClick={clearFilters} aria-pressed={!hasFilters}>全部内容 <small>{facets.data?.total ?? 0}</small></button>
          {facets.data?.categories.map((item) => <button key={item.name} className={format === item.name ? "active" : ""} onClick={() => selectFormat(item.name)} aria-pressed={format === item.name}>{formatLabels[item.name] || item.name} <small>{item.count}</small></button>)}
        </div>
        <div className="filter-group">
          <span>热门主题</span>
          {facets.data?.domains.slice(0, 12).map((item) => <button key={item.name} className={domain === item.name ? "active" : ""} onClick={() => selectDomain(item.name)} aria-pressed={domain === item.name}>{item.name} <small>{item.count}</small></button>)}
        </div>
        <div className="filter-group">
          <span>知识点</span>
          {facets.data?.knowledgePoints.slice(0, 10).map((item) => <button key={item.name} className={knowledgePoint === item.name ? "active" : ""} onClick={() => selectKnowledgePoint(item.name)} aria-pressed={knowledgePoint === item.name}>{item.name} <small>{item.count}</small></button>)}
        </div>
        <div className="filter-group">
          <span>工具与平台</span>
          {facets.data?.tools.slice(0, 8).map((item) => <button key={item.name} className={tool === item.name ? "active" : ""} onClick={() => selectTool(item.name)} aria-pressed={tool === item.name}>{item.name} <small>{item.count}</small></button>)}
        </div>
      </aside>
      <div>
        {activeFilter || activeFilters.length ? <div className="library-active-filters" aria-label="当前筛选条件"><span>当前范围</span>{activeFilter && <strong>{activeFilter}</strong>}{activeFilters.map((filter) => <button key={filter.key} onClick={filter.clear} aria-label={`移除筛选条件：${filter.label}`}>{filter.label}<X size={13} /></button>)}<button className="library-filter-reset" onClick={clearFilters}>清除全部</button></div> : null}
        {query.isLoading ? <LoadingState label="正在加载知识库" /> : query.isError && !items.length ? <EmptyState icon={<BookOpen size={28} />} title="知识库加载失败" description={query.error instanceof Error ? query.error.message : "暂时无法读取知识库内容。"} action={<button className="button button-secondary" onClick={() => void query.refetch()}>重新加载</button>} /> : items.length ? <><div className={`library-grid ${viewMode === "list" ? "library-list" : ""}`}>{items.map((item) => <Link className="knowledge-card" key={item.id} to={`/reader/${encodeURIComponent(item.id)}`} state={{ from: "/library" }} aria-label={`阅读：${item.title}`}><KnowledgeCardCover item={item} /><div className="knowledge-card-body"><div className="knowledge-meta"><span>{formatLabels[item.contentFormat] || item.category}</span><time>{formatDate(item.receivedAt).slice(0, 10)}</time></div><h2>{item.title}</h2><p>{item.summary || "暂无摘要"}</p><div className="tag-row">{(item.domains.length ? item.domains : item.tags).slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div><div className="card-link">阅读全文 <ArrowRight size={16} /></div></div></Link>)}</div><div className="library-pagination" role="status" aria-live="polite"><span>{query.isFetchNextPageError ? "更多内容加载失败，可重试" : `已显示 ${items.length} / ${total} 篇`}</span>{query.hasNextPage && <button className="button button-secondary" disabled={query.isFetchingNextPage} onClick={() => void loadMore()}>{query.isFetchingNextPage ? "正在加载…" : query.isFetchNextPageError ? "重新加载" : `加载更多（剩余 ${Math.max(0, total - items.length)} 篇）`}</button>}</div></> : <EmptyState icon={<BookOpen size={28} />} title="没有符合条件的内容" description={hasFilters ? "当前组合条件下没有内容，可以移除部分条件或清除筛选。" : "整理完成的内容会自动出现在这里。"} action={hasFilters ? <button className="button button-secondary" onClick={clearFilters}>清除筛选并显示全部</button> : undefined} />}
      </div>
    </section>
    {collectionOpen && <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget && !createCollection.isPending) setCollectionOpen(false); }}><form ref={collectionDialogRef} className="collection-dialog" role="dialog" aria-modal="true" aria-labelledby="collection-dialog-title" tabIndex={-1} onSubmit={saveCollection}><div><span className="eyebrow">SMART COLLECTION</span><h2 id="collection-dialog-title">保存为智能集合</h2><p>当前筛选条件会持续生效，新整理的内容也会自动进入集合。</p></div><label>集合名称<input name="name" data-modal-initial-focus required maxLength={60} placeholder={activeFilter || "例如：待读的 AI 资料"} /></label><div className="collection-rule-preview"><strong>包含条件</strong><span>{[format && (formatLabels[format] || format), domain, knowledgePoint, tool, favorite && "重点收藏", unread && "尚未阅读", search.trim()].filter(Boolean).join(" · ") || "全部已整理内容"}</span></div><div className="form-actions"><button type="button" className="button button-secondary" disabled={createCollection.isPending} onClick={() => setCollectionOpen(false)}>取消</button><button className="button button-primary" disabled={createCollection.isPending}>{createCollection.isPending ? "正在保存…" : "保存集合"}</button></div></form></div>}
  </main>;
}
