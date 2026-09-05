import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowDown, ArrowUpRight, BookOpenCheck, Check, Copy, MessageCircleQuestion, Plus, RefreshCw, Search, Send, ShieldCheck, Sparkles, Square, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, streamApi } from "../api";
import { useApp } from "../App";
import type { KnowledgeChatMessage, KnowledgeConversation, KnowledgeFacets, SmartCollection } from "../types";
import { EmptyState, InlineMessage, LoadingState, PageHeader, formatDate } from "../components/ui";
import { useConfirm } from "../components/ConfirmDialog";

type ConversationList = { conversations: KnowledgeConversation[]; total: number; hasMore: boolean };
type ConversationDetail = { conversation: KnowledgeConversation & { messages: KnowledgeChatMessage[] } };
type ScopeOption = { key: string; type: KnowledgeConversation["scopeType"]; value: string; label: string };
type KnowledgeChatStreamEvent =
  | { type: "status"; phase: "retrieving" | "reading" | "generating"; message: string }
  | { type: "delta"; content: string }
  | { type: "heartbeat"; at: string }
  | { type: "done"; message: KnowledgeChatMessage; followUps: string[] }
  | { type: "error"; error: string };

const examples = [
  "把我收藏过的 AI Agent 实践方法归纳成一套实施步骤",
  "我保存的 NAS 资料里，对备份方案有哪些共同建议？",
  "对比知识库中几篇相关文章的主要观点和分歧",
];

function conversationPreview(content?: string) {
  if (!content) return "尚未提问";
  return content
    .replace(/```[\s\S]*?```/g, " [代码] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " [图片] ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s{1,})#{1,6}\s+/g, "$1")
    .replace(/[>*_~|]+/g, " ")
    .replace(/\[(?:S\d+|\d+)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export default function KnowledgeChatPage() {
  const { notify } = useApp();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState("");
  const [question, setQuestion] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [pendingConversationId, setPendingConversationId] = useState("");
  const [streamedAnswer, setStreamedAnswer] = useState("");
  const [streamStatus, setStreamStatus] = useState("正在检索知识库并核对资料依据…");
  const [streamPhase, setStreamPhase] = useState<"retrieving" | "reading" | "generating">("retrieving");
  const [streaming, setStreaming] = useState(false);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [conversationSearch, setConversationSearch] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [streamError, setStreamError] = useState("");
  const [showLatest, setShowLatest] = useState(false);
  const [scopeKey, setScopeKey] = useState("library:");
  const [linkedScope, setLinkedScope] = useState<ScopeOption | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const streamControllerRef = useRef<AbortController | null>(null);

  const conversations = useInfiniteQuery({
    queryKey: ["knowledge-chats", conversationSearch.trim()],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "30", offset: String(pageParam) });
      if (conversationSearch.trim()) params.set("q", conversationSearch.trim());
      return api<ConversationList>(`/api/knowledge/chats?${params.toString()}`);
    },
    getNextPageParam: (lastPage, pages) => lastPage.hasMore
      ? pages.reduce((count, page) => count + page.conversations.length, 0)
      : undefined,
    refetchOnWindowFocus: true,
  });
  const allConversations = useMemo(
    () => conversations.data?.pages.flatMap((page) => page.conversations) || [],
    [conversations.data?.pages],
  );
  const facets = useQuery({
    queryKey: ["knowledge-facets", "chat-scopes"],
    queryFn: () => api<KnowledgeFacets>("/api/knowledge/facets?organized=1&limit=30"),
    staleTime: 60_000,
  });
  const collections = useQuery({
    queryKey: ["smart-collections"],
    queryFn: () => api<{ collections: SmartCollection[] }>("/api/collections"),
    staleTime: 30_000,
  });
  const detail = useQuery({
    queryKey: ["knowledge-chat", activeId],
    queryFn: () => api<ConversationDetail>(`/api/knowledge/chats/${activeId}`),
    enabled: Boolean(activeId),
    refetchInterval: pendingConversationId === activeId && !streaming ? 4_000 : false,
  });

  useEffect(() => {
    if (!activeId && allConversations[0]) setActiveId(allConversations[0].id);
  }, [activeId, allConversations]);
  useEffect(() => {
    const conversation = detail.data?.conversation;
    if (conversation) setScopeKey(`${conversation.scopeType}:${conversation.scopeValue}`);
  }, [detail.data?.conversation]);
  useEffect(() => {
    const initialQuestion = searchParams.get("question")?.trim();
    const linkedType = searchParams.get("scopeType");
    const linkedValue = searchParams.get("scopeValue")?.trim() || "";
    const linkedLabel = searchParams.get("scopeLabel")?.trim() || "当前内容";
    if (!initialQuestion && !(linkedType === "message" && linkedValue)) return;
    if (initialQuestion) setQuestion(initialQuestion);
    if (linkedType === "message" && linkedValue) {
      const option: ScopeOption = { key: `message:${linkedValue}`, type: "message", value: linkedValue, label: `本篇 · ${linkedLabel}` };
      setLinkedScope(option);
      setScopeKey(option.key);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("question");
    next.delete("scopeType");
    next.delete("scopeValue");
    next.delete("scopeLabel");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  useEffect(() => {
    if (!(detail.data?.conversation.messages.length || pendingQuestion || streamedAnswer)) return;
    if (followOutputRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end", behavior: streamedAnswer ? "auto" : "smooth" });
      setShowLatest(false);
    } else if (streaming) setShowLatest(true);
  }, [detail.data?.conversation.messages.length, pendingQuestion, streamedAnswer]);
  useEffect(() => () => streamControllerRef.current?.abort(), []);
  useEffect(() => {
    if (streaming || !pendingQuestion || pendingConversationId !== activeId) return;
    const latest = detail.data?.conversation.messages.at(-1);
    if (latest?.role !== "assistant") return;
    setPendingQuestion("");
    setPendingConversationId("");
    setStreamedAnswer("");
    setStreamError("");
  }, [activeId, detail.data?.conversation.messages, pendingConversationId, pendingQuestion, streaming]);

  const scopeOptions = useMemo<ScopeOption[]>(() => {
    const options: ScopeOption[] = [
      { key: "library:", type: "library", value: "", label: "全部知识库" },
    ...(linkedScope ? [linkedScope] : []),
    ...(collections.data?.collections || []).map((collection) => ({
      key: `collection:${collection.id}`,
      type: "collection" as const,
      value: collection.id,
      label: `集合 · ${collection.name}`,
    })),
    ...(facets.data?.domains || []).map((domain) => ({
      key: `domain:${domain.name}`,
      type: "domain" as const,
      value: domain.name,
      label: `领域 · ${domain.name}`,
    })),
    ];
    const current = detail.data?.conversation;
    if (current) {
      const key = `${current.scopeType}:${current.scopeValue}`;
      if (!options.some((item) => item.key === key)) {
        options.splice(1, 0, { key, type: current.scopeType, value: current.scopeValue, label: current.scopeLabel });
      }
    }
    return options;
  }, [collections.data?.collections, detail.data?.conversation, facets.data?.domains, linkedScope]);
  const selectedScope = scopeOptions.find((item) => item.key === scopeKey) || scopeOptions[0]!;

  const createConversation = useMutation({
    mutationFn: (scope: ScopeOption = selectedScope) => api<{ conversation: KnowledgeConversation }>("/api/knowledge/chats", {
      method: "POST",
      body: JSON.stringify({ scopeType: scope.type, scopeValue: scope.value }),
    }),
    onSuccess: ({ conversation }) => {
      setActiveId(conversation.id);
      setScopeKey(`${conversation.scopeType}:${conversation.scopeValue}`);
      setFollowUps([]);
      void queryClient.invalidateQueries({ queryKey: ["knowledge-chats"] });
    },
    onError: (error) => notify(error instanceof Error ? error.message : "新建问答失败，请重试", "danger"),
  });

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const content = question.trim();
    if (!content || streaming) return;
    let conversationId = activeId;
    let controller: AbortController | null = null;
    let completed = false;
    try {
      const activeConversation = detail.data?.conversation || allConversations.find((conversation) => conversation.id === activeId);
      const activeScopeKey = activeConversation ? `${activeConversation.scopeType}:${activeConversation.scopeValue}` : "";
      if (!conversationId || activeScopeKey !== selectedScope.key) {
        const created = await api<{ conversation: KnowledgeConversation }>("/api/knowledge/chats", {
          method: "POST",
          body: JSON.stringify({ scopeType: selectedScope.type, scopeValue: selectedScope.value }),
        });
        conversationId = created.conversation.id;
        setActiveId(conversationId);
        void queryClient.invalidateQueries({ queryKey: ["knowledge-chats"] });
      }
      setQuestion("");
      setPendingQuestion(content);
      setPendingConversationId(conversationId);
      setStreamedAnswer("");
      setStreamStatus("正在理解问题并检索知识库…");
      setStreamPhase("retrieving");
      setFollowUps([]);
      setStreamError("");
      setStreaming(true);
      followOutputRef.current = true;
      controller = new AbortController();
      streamControllerRef.current = controller;
      await streamApi<KnowledgeChatStreamEvent>(
        `/api/knowledge/chats/${conversationId}/messages/stream`,
        {
          method: "POST",
          body: JSON.stringify({ question: content }),
          signal: controller.signal,
        },
        (message) => {
          if (message.type === "status") { setStreamStatus(message.message); setStreamPhase(message.phase); }
          else if (message.type === "delta") setStreamedAnswer((current) => current + message.content);
          else if (message.type === "done") { completed = true; setFollowUps(message.followUps); }
          else if (message.type === "error") throw new Error(message.error);
        },
      );
      await queryClient.refetchQueries({ queryKey: ["knowledge-chat", conversationId], exact: true });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-chats"] });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const message = error instanceof Error ? error.message : "知识问答暂时失败";
        setQuestion((current) => current || content);
        setStreamError(message);
        notify(message, "danger");
      } else {
        setStreamError("已停止接收实时内容。服务端可能仍在完成回答，可刷新会话查看最终结果。");
      }
      void queryClient.invalidateQueries({ queryKey: ["knowledge-chat", conversationId] });
    } finally {
      if (controller && streamControllerRef.current === controller) streamControllerRef.current = null;
      if (completed) {
        setPendingQuestion("");
        setPendingConversationId("");
        setStreamedAnswer("");
        setStreamError("");
      }
      setStreaming(false);
    }
  }

  async function removeConversation(conversation: KnowledgeConversation) {
    if (!await confirm({ title: "删除这段问答？", description: `“${conversation.title}”的问答记录将被删除，知识库原始资料不会受到影响。`, confirmLabel: "删除问答", tone: "danger" })) return;
    try {
      await api(`/api/knowledge/chats/${conversation.id}`, { method: "DELETE" });
      if (activeId === conversation.id) setActiveId("");
      setFollowUps([]);
      notify("问答会话已删除", "success");
      void queryClient.invalidateQueries({ queryKey: ["knowledge-chats"] });
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除问答失败，请重试", "danger");
    }
  }

  const messages = detail.data?.conversation.messages || [];
  const pendingForActiveConversation = Boolean(pendingQuestion && pendingConversationId === activeId);
  const filteredConversations = allConversations;

  async function copyAnswer(message: KnowledgeChatMessage) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId(""), 1800);
    } catch {
      notify("复制失败，请手动选择回答内容", "danger");
    }
  }

  function stopStreaming() {
    streamControllerRef.current?.abort();
    streamControllerRef.current = null;
    setStreaming(false);
    notify("已停止实时接收；服务端完成后的回答仍会保存在会话中", "default");
  }

  function handleTranscriptScroll() {
    const element = transcriptRef.current;
    if (!element) return;
    followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    if (followOutputRef.current) setShowLatest(false);
  }

  function scrollToLatest() {
    followOutputRef.current = true;
    setShowLatest(false);
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }

  return <main className="page knowledge-chat-page">
    <PageHeader eyebrow="GROUNDED KNOWLEDGE CHAT" title="知识问答" description="围绕你已整理的收藏内容持续提问，回答会标明知识库依据。" />
    <section className="knowledge-chat-shell panel">
      <aside className="chat-history-panel">
        <div className="chat-history-head"><div><strong>问答记录</strong><small>{conversations.data?.pages[0]?.total || 0} 个会话</small></div><button className="icon-button" aria-label="新建问答" title="使用当前范围新建问答" onClick={() => createConversation.mutate(selectedScope)} disabled={createConversation.isPending}><Plus size={19} /></button></div>
        <label className="chat-history-search"><Search size={15} /><input value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder="搜索会话" /></label>
        <div className={`chat-history-list ${filteredConversations.length ? "" : "empty"}`}>
          {conversations.isLoading ? <LoadingState label="正在加载问答记录" /> : conversations.isError ? <div className="chat-history-error"><AlertCircle size={18} /><span>问答记录加载失败</span><button onClick={() => void conversations.refetch()}>重试</button></div> : filteredConversations.length ? filteredConversations.map((conversation) => <div className={`chat-history-item ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}><button disabled={streaming} onClick={() => { setActiveId(conversation.id); setScopeKey(`${conversation.scopeType}:${conversation.scopeValue}`); setFollowUps([]); setStreamError(""); }}><strong>{conversation.title}</strong><span>{conversationPreview(conversation.lastMessage)}</span><small>{conversation.scopeLabel} · {formatDate(conversation.updatedAt)}</small></button><button className="chat-delete" disabled={streaming} aria-label={`删除会话 ${conversation.title}`} onClick={() => void removeConversation(conversation)}><Trash2 size={15} /></button></div>) : <p className="chat-history-empty">{conversationSearch ? "没有匹配的会话" : "还没有问答记录"}</p>}
          {conversations.hasNextPage ? <button className="chat-load-more" type="button" disabled={conversations.isFetchingNextPage} onClick={() => void conversations.fetchNextPage()}>{conversations.isFetchingNextPage ? "正在加载…" : conversationSearch ? "加载更多匹配会话" : "加载更早的会话"}</button> : null}
        </div>
      </aside>
      <div className="chat-main">
        <div className="chat-scope-banner"><ShieldCheck size={18} /><div><strong>仅依据：{detail.data?.conversation.scopeLabel || selectedScope.label}</strong><span>不会用网络信息或模型记忆补充事实；资料不足时会明确说明。</span></div><label className="chat-scope-picker"><span>问答范围</span><select value={scopeKey} disabled={streaming} onChange={(event) => setScopeKey(event.target.value)}>{scopeOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label></div>
        <div className="chat-transcript" ref={transcriptRef} onScroll={handleTranscriptScroll} aria-live="polite">
          {detail.isLoading && activeId ? <LoadingState label="正在打开问答" /> : detail.isError ? <EmptyState icon={<AlertCircle size={25} />} title="无法打开这段问答" description="服务暂时没有返回会话内容，请重试。" action={<button className="button button-secondary" onClick={() => void detail.refetch()}><RefreshCw size={16} />重新加载</button>} /> : null}
          {!messages.length && !pendingForActiveConversation ? <div className="chat-welcome"><span><MessageCircleQuestion size={30} /></span><h2>从收藏中获得答案</h2><p>适合归纳多篇文章、比较观点、提炼方法，或者围绕同一主题连续追问。</p><div>{examples.map((example) => <button key={example} onClick={() => setQuestion(example)}>{example}</button>)}</div></div> : null}
          {messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}>
            <div className="chat-message-label">{message.role === "user" ? "你" : <><Sparkles size={14} />知流{message.role === "assistant" ? <button className="chat-copy" onClick={() => void copyAnswer(message)} aria-label="复制回答">{copiedId === message.id ? <Check size={14} /> : <Copy size={14} />}{copiedId === message.id ? "已复制" : "复制"}</button> : null}</>}</div>
            <div className="chat-message-content">{message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : <p>{message.content}</p>}</div>
            {message.citations.length ? <div className="chat-citations"><strong><BookOpenCheck size={15} />回答依据</strong>{message.citations.map((citation, index) => <button key={citation.messageId} onClick={() => navigate(`/reader/${encodeURIComponent(citation.messageId)}`)}><span>{citation.reference || `S${index + 1}`}</span><div><b>{citation.title}</b><small>{citation.excerpt || "打开查看资料"}</small></div><ArrowUpRight size={15} /></button>)}</div> : null}
          </article>)}
          {pendingForActiveConversation ? <><article className="chat-message user"><div className="chat-message-label">你</div><div className="chat-message-content"><p>{pendingQuestion}</p></div></article><article className="chat-message assistant pending"><div className="chat-message-label"><Sparkles size={14} />知流</div><div className="chat-progress"><span className={streamPhase === "retrieving" ? "active" : "done"}>1 检索</span><span className={streamPhase === "reading" ? "active" : streamPhase === "generating" ? "done" : ""}>2 核对</span><span className={streamPhase === "generating" ? "active" : ""}>3 生成</span><small>{streamStatus}</small></div>{streamedAnswer ? <div className="chat-message-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{streamedAnswer}</ReactMarkdown><span className="stream-caret" aria-hidden="true" /></div> : <div className="chat-thinking"><i /><i /><i /><span>正在准备有依据的回答</span></div>}</article></> : null}
          {streamError && pendingForActiveConversation ? <InlineMessage tone="warning"><span>{streamError}</span><button className="text-link" type="button" onClick={() => void detail.refetch()}><RefreshCw size={14} />刷新会话</button></InlineMessage> : null}
          <div ref={bottomRef} />
        </div>
        {showLatest && <button className="chat-jump-latest" type="button" onClick={scrollToLatest}><ArrowDown size={15} />查看新内容</button>}
        {followUps.length ? <div className="chat-follow-ups"><span>可以继续问</span>{followUps.map((item) => <button key={item} onClick={() => setQuestion(item)}>{item}</button>)}</div> : null}
        <form className="chat-composer" onSubmit={(event) => void submit(event)}>
          <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} rows={2} maxLength={2000} disabled={streaming} placeholder="基于我的收藏提问；Enter 发送，Shift + Enter 换行" />
          <div><span>{detail.data?.conversation && `${detail.data.conversation.scopeType}:${detail.data.conversation.scopeValue}` !== selectedScope.key ? `发送时将新建“${selectedScope.label}”范围对话` : `回答只使用“${detail.data?.conversation.scopeLabel || selectedScope.label}”内已整理的资料`}</span>{streaming ? <button className="button button-secondary" type="button" onClick={stopStreaming}><Square size={15} />停止生成</button> : <button className="button button-primary" disabled={!question.trim()}><Send size={17} />发送</button>}</div>
        </form>
      </div>
    </section>
  </main>;
}
