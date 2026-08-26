import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, BookOpenCheck, MessageCircleQuestion, Plus, Send, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate } from "react-router-dom";
import { api, streamApi } from "../api";
import { useApp } from "../App";
import type { KnowledgeChatMessage, KnowledgeConversation } from "../types";
import { LoadingState, PageHeader, formatDate } from "../components/ui";

type ConversationList = { conversations: KnowledgeConversation[]; total: number; hasMore: boolean };
type ConversationDetail = { conversation: KnowledgeConversation & { messages: KnowledgeChatMessage[] } };
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

export default function KnowledgeChatPage() {
  const { notify } = useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState("");
  const [question, setQuestion] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [pendingConversationId, setPendingConversationId] = useState("");
  const [streamedAnswer, setStreamedAnswer] = useState("");
  const [streamStatus, setStreamStatus] = useState("正在检索知识库并核对资料依据…");
  const [streaming, setStreaming] = useState(false);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamControllerRef = useRef<AbortController | null>(null);

  const conversations = useQuery({
    queryKey: ["knowledge-chats"],
    queryFn: () => api<ConversationList>("/api/knowledge/chats?limit=30"),
    refetchOnWindowFocus: true,
  });
  const detail = useQuery({
    queryKey: ["knowledge-chat", activeId],
    queryFn: () => api<ConversationDetail>(`/api/knowledge/chats/${activeId}`),
    enabled: Boolean(activeId),
  });

  useEffect(() => {
    if (!activeId && conversations.data?.conversations[0]) setActiveId(conversations.data.conversations[0].id);
  }, [activeId, conversations.data]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [detail.data?.conversation.messages.length, pendingQuestion, streamedAnswer]);
  useEffect(() => () => streamControllerRef.current?.abort(), []);

  const createConversation = useMutation({
    mutationFn: () => api<{ conversation: KnowledgeConversation }>("/api/knowledge/chats", {
      method: "POST",
      body: JSON.stringify({}),
    }),
    onSuccess: ({ conversation }) => {
      setActiveId(conversation.id);
      setFollowUps([]);
      void queryClient.invalidateQueries({ queryKey: ["knowledge-chats"] });
    },
  });

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const content = question.trim();
    if (!content || streaming) return;
    let conversationId = activeId;
    if (!conversationId) {
      const created = await api<{ conversation: KnowledgeConversation }>("/api/knowledge/chats", {
        method: "POST",
        body: JSON.stringify({}),
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
    setFollowUps([]);
    setStreaming(true);
    const controller = new AbortController();
    streamControllerRef.current = controller;
    try {
      await streamApi<KnowledgeChatStreamEvent>(
        `/api/knowledge/chats/${conversationId}/messages/stream`,
        {
          method: "POST",
          body: JSON.stringify({ question: content }),
          signal: controller.signal,
        },
        (message) => {
          if (message.type === "status") setStreamStatus(message.message);
          else if (message.type === "delta") setStreamedAnswer((current) => current + message.content);
          else if (message.type === "done") setFollowUps(message.followUps);
          else if (message.type === "error") throw new Error(message.error);
        },
      );
      await queryClient.refetchQueries({ queryKey: ["knowledge-chat", conversationId], exact: true });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-chats"] });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        notify(error instanceof Error ? error.message : "知识问答暂时失败", "danger");
      }
      void queryClient.invalidateQueries({ queryKey: ["knowledge-chat", conversationId] });
    } finally {
      if (streamControllerRef.current === controller) streamControllerRef.current = null;
      setPendingQuestion("");
      setPendingConversationId("");
      setStreamedAnswer("");
      setStreaming(false);
    }
  }

  async function removeConversation(conversation: KnowledgeConversation) {
    if (!window.confirm(`删除问答会话“${conversation.title}”？此操作不会删除知识库资料。`)) return;
    await api(`/api/knowledge/chats/${conversation.id}`, { method: "DELETE" });
    if (activeId === conversation.id) setActiveId("");
    setFollowUps([]);
    notify("问答会话已删除", "success");
    void queryClient.invalidateQueries({ queryKey: ["knowledge-chats"] });
  }

  const messages = detail.data?.conversation.messages || [];
  const pendingForActiveConversation = Boolean(pendingQuestion && pendingConversationId === activeId);

  return <main className="page knowledge-chat-page">
    <PageHeader eyebrow="GROUNDED KNOWLEDGE CHAT" title="知识问答" description="围绕你已整理的收藏内容持续提问，回答会标明知识库依据。" />
    <section className="knowledge-chat-shell panel">
      <aside className="chat-history-panel">
        <div className="chat-history-head"><div><strong>问答记录</strong><small>{conversations.data?.total || 0} 个会话</small></div><button className="icon-button" aria-label="新建问答" title="新建问答" onClick={() => createConversation.mutate()} disabled={createConversation.isPending}><Plus size={19} /></button></div>
        <div className="chat-history-list">
          {conversations.isLoading ? <LoadingState label="正在加载问答记录" /> : conversations.data?.conversations.length ? conversations.data.conversations.map((conversation) => <div className={`chat-history-item ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}><button onClick={() => { setActiveId(conversation.id); setFollowUps([]); }}><strong>{conversation.title}</strong><span>{conversation.lastMessage || "尚未提问"}</span><small>{formatDate(conversation.updatedAt)}</small></button><button className="chat-delete" aria-label={`删除会话 ${conversation.title}`} onClick={() => void removeConversation(conversation)}><Trash2 size={15} /></button></div>) : <p className="chat-history-empty">还没有问答记录</p>}
        </div>
      </aside>
      <div className="chat-main">
        <div className="chat-scope-banner"><ShieldCheck size={18} /><div><strong>仅依据个人知识库</strong><span>不会用网络信息或模型记忆补充事实；资料不足时会明确说明。</span></div></div>
        <div className="chat-transcript" aria-live="polite">
          {!messages.length && !pendingForActiveConversation ? <div className="chat-welcome"><span><MessageCircleQuestion size={30} /></span><h2>从收藏中获得答案</h2><p>适合归纳多篇文章、比较观点、提炼方法，或者围绕同一主题连续追问。</p><div>{examples.map((example) => <button key={example} onClick={() => setQuestion(example)}>{example}</button>)}</div></div> : null}
          {messages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}>
            <div className="chat-message-label">{message.role === "user" ? "你" : <><Sparkles size={14} />知流</>}</div>
            <div className="chat-message-content">{message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : <p>{message.content}</p>}</div>
            {message.citations.length ? <div className="chat-citations"><strong><BookOpenCheck size={15} />回答依据</strong>{message.citations.map((citation, index) => <button key={citation.messageId} onClick={() => navigate(`/reader/${encodeURIComponent(citation.messageId)}`)}><span>{citation.reference || `S${index + 1}`}</span><div><b>{citation.title}</b><small>{citation.excerpt || "打开查看资料"}</small></div><ArrowUpRight size={15} /></button>)}</div> : null}
          </article>)}
          {pendingForActiveConversation ? <><article className="chat-message user"><div className="chat-message-label">你</div><div className="chat-message-content"><p>{pendingQuestion}</p></div></article><article className="chat-message assistant pending"><div className="chat-message-label"><Sparkles size={14} />知流</div>{streamedAnswer ? <div className="chat-message-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{streamedAnswer}</ReactMarkdown><span className="stream-caret" aria-hidden="true" /></div> : <div className="chat-thinking"><i /><i /><i /><span>{streamStatus}</span></div>}</article></> : null}
          <div ref={bottomRef} />
        </div>
        {followUps.length ? <div className="chat-follow-ups"><span>可以继续问</span>{followUps.map((item) => <button key={item} onClick={() => setQuestion(item)}>{item}</button>)}</div> : null}
        <form className="chat-composer" onSubmit={(event) => void submit(event)}>
          <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} rows={2} maxLength={2000} disabled={streaming} placeholder="基于我的收藏提问；Enter 发送，Shift + Enter 换行" />
          <div><span>回答只使用已完成 AI 整理的个人资料</span><button className="button button-primary" disabled={!question.trim() || streaming}><Send size={17} />{streaming ? "回答中" : "发送"}</button></div>
        </form>
      </div>
    </section>
  </main>;
}
