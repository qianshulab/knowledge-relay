import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpenCheck, CheckCircle2, Clock3, Eye, Heart, RotateCcw, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, attachmentUrl } from "../api";
import { useApp } from "../App";
import { EmptyState, LoadingState, PageHeader, formatDate, formatLabels } from "../components/ui";
import type { ReviewSuggestion } from "../types";

type ReviewResponse = {
  suggestions: ReviewSuggestion[];
  overview: { due: number; unread: number; favorites: number };
};

export default function ReviewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useApp();
  const review = useQuery({
    queryKey: ["review-suggestions"],
    queryFn: () => api<ReviewResponse>("/api/review?limit=12"),
    refetchOnWindowFocus: true,
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "reviewed" | "snoozed" | "mastered" | "dismissed" }) =>
      api(`/api/review/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ action, snoozeDays: 7 }),
      }),
    onSuccess: (_data, variables) => {
      notify(variables.action === "snoozed" ? "已推迟一周提醒" : variables.action === "mastered" ? "已标记为掌握" : "回顾状态已更新", "success");
      void queryClient.invalidateQueries({ queryKey: ["review-suggestions"] });
    },
  });

  function open(item: ReviewSuggestion) {
    act.mutate({ id: item.id, action: "reviewed" });
    navigate(`/reader/${encodeURIComponent(item.id)}`);
  }

  const overview = review.data?.overview;
  return <main className="page review-page">
    <PageHeader eyebrow="KNOWLEDGE REVIEW" title="回顾" description="让收藏过的内容在合适的时间重新出现，而不是沉入不断增长的收件箱。" />
    <section className="review-overview" aria-label="今日回顾概览">
      <div><span className="metric-icon"><Sparkles size={18} /></span><span>今日待回顾</span><strong>{overview?.due ?? 0}</strong></div>
      <div><span className="metric-icon"><Eye size={18} /></span><span>尚未阅读</span><strong>{overview?.unread ?? 0}</strong></div>
      <div><span className="metric-icon"><Heart size={18} /></span><span>重点收藏</span><strong>{overview?.favorites ?? 0}</strong></div>
    </section>
    <section className="review-section-head"><div><h2>今天值得重看的内容</h2><p>依据阅读状态、收藏时间和重点标记排序，每次只给出一组可完成的内容。</p></div><button className="button button-secondary" onClick={() => void review.refetch()}><RotateCcw size={16} />换一组</button></section>
    {review.isLoading ? <LoadingState label="正在准备今日回顾" /> : review.data?.suggestions.length ? <div className="review-grid">
      {review.data.suggestions.map((item) => <article className="review-card" key={item.id}>
        <button className="review-card-main" onClick={() => open(item)}>
          <div className="review-cover">
            {item.coverAttachmentId ? <img src={attachmentUrl(item.coverAttachmentId)} alt="" /> : <span><BookOpenCheck size={26} /><small>{formatLabels[item.contentFormat] || "知识内容"}</small></span>}
          </div>
          <div className="review-copy"><div className="review-reason"><Clock3 size={14} />{item.reason}</div><h2>{item.title}</h2><p>{item.summary || item.text.slice(0, 140) || "打开内容继续阅读。"}</p><div className="review-meta"><span>{formatLabels[item.contentFormat] || item.category}</span><time>{formatDate(item.receivedAt).slice(0, 10)}</time>{item.favorite && <span className="favorite-mark"><Heart size={13} fill="currentColor" />重点</span>}</div><span className="review-open">开始回顾 <ArrowRight size={15} /></span></div>
        </button>
        <div className="review-card-actions"><button onClick={() => act.mutate({ id: item.id, action: "snoozed" })}><Clock3 size={15} />一周后提醒</button><button onClick={() => act.mutate({ id: item.id, action: "mastered" })}><CheckCircle2 size={15} />已经掌握</button></div>
      </article>)}
    </div> : <EmptyState icon={<CheckCircle2 size={30} />} title="今天的回顾已完成" description="新的内容会根据阅读状态和收藏时间，在合适的时候出现在这里。" action={<button className="button button-primary" onClick={() => navigate("/library")}>继续浏览知识库</button>} />}
  </main>;
}
