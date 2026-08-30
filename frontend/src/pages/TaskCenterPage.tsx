import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCircle2, Clock3, Database, FileSearch, ListTodo, RefreshCw, RotateCcw, Sparkles, XCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../App";
import { EmptyState, LoadingState, PageHeader, formatDate } from "../components/ui";
import type { BackgroundJob, BackgroundJobResponse, BackgroundJobStatus, BackgroundJobType } from "../types";

type Filter = "all" | "active" | "failed" | "completed";

const typeLabels: Record<BackgroundJobType, string> = {
  ingestion: "新内容整理",
  reprocess: "重新整理",
  diagram: "智能图解",
  index: "检索索引",
  sync: "内容同步",
  source_check: "来源检查",
};

const statusLabels: Record<BackgroundJobStatus, string> = {
  queued: "排队中",
  running: "处理中",
  retrying: "正在重试",
  completed: "已完成",
  failed: "处理失败",
  cancelled: "已取消",
};

function statusTone(status: BackgroundJobStatus) {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "retrying") return "warning";
  if (status === "queued" || status === "running") return "processing";
  return "";
}

function isActive(job: BackgroundJob) {
  return ["queued", "running", "retrying"].includes(job.status);
}

export default function TaskCenterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const jobs = useQuery({
    queryKey: ["background-jobs"],
    queryFn: () => api<BackgroundJobResponse>("/api/jobs?limit=100"),
    refetchInterval: (query) => query.state.data?.overview.active ? 3_000 : 15_000,
    refetchOnWindowFocus: true,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    onSuccess: () => {
      notify("排队任务已取消", "success");
      void queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) => notify(error instanceof Error ? error.message : "取消失败", "danger"),
  });
  const rebuildIndex = useMutation({
    mutationFn: () => api("/api/jobs/index/rebuild", { method: "POST" }),
    onSuccess: () => {
      notify("索引检查已进入后台任务", "success");
      void queryClient.invalidateQueries({ queryKey: ["background-jobs"] });
    },
    onError: (error) => notify(error instanceof Error ? error.message : "无法启动索引检查", "danger"),
  });
  const visibleJobs = useMemo(() => (jobs.data?.jobs || []).filter((job) => {
    if (filter === "active") return isActive(job);
    if (filter === "failed") return job.status === "failed";
    if (filter === "completed") return job.status === "completed";
    return true;
  }), [filter, jobs.data?.jobs]);
  const overview = jobs.data?.overview;
  const index = jobs.data?.searchIndex;

  return <main className="page task-center-page">
    <PageHeader eyebrow="BACKGROUND OPERATIONS" title="任务中心" description="整理、图解、索引和同步都会在后台持续执行。关闭页面后任务不会丢失，重新打开仍可查看真实进度。" actions={<button className="button button-secondary" disabled={jobs.isFetching} onClick={() => void jobs.refetch()}><RefreshCw className={jobs.isFetching ? "spin" : ""} size={17} />刷新状态</button>} />
    <section className="metrics-grid task-metrics" aria-label="后台任务概览">
      <article className="metric-card"><span><Sparkles size={18} />正在处理</span><strong>{overview?.active ?? "—"}</strong><small>运行、排队与重试任务</small></article>
      <article className="metric-card"><span><Clock3 size={18} />排队等待</span><strong>{overview?.queued ?? "—"}</strong><small>等待引擎接手的任务</small></article>
      <article className="metric-card"><span><AlertTriangle size={18} />需要处理</span><strong>{overview?.failed ?? "—"}</strong><small>失败任务会保留原因</small></article>
      <article className="metric-card"><span><CheckCircle2 size={18} />今日完成</span><strong>{overview?.completedToday ?? "—"}</strong><small>今天成功完成的后台任务</small></article>
    </section>
    <section className="task-health-grid">
      <article className="panel task-health-card"><span className="task-health-icon"><Bot size={20} /></span><div><small>智能处理引擎</small><strong>{overview?.active ? `${overview.active} 个任务正在推进` : "当前运行平稳"}</strong><p>{overview?.retrying ? `${overview.retrying} 个任务正在自动重试，不需要重复提交。` : "失败与重试状态会跨页面保留。"}</p></div></article>
      <article className="panel task-health-card"><span className="task-health-icon"><Database size={20} /></span><div><small>知识检索索引</small><strong>{index ? `${index.coverage}% 已建立索引` : "正在读取索引"}</strong><p>{index ? `${index.indexedMessages}/${index.completedMessages} 篇内容 · ${index.indexedChunks} 个可检索片段${index.missingMessages ? ` · ${index.missingMessages} 篇待补齐` : ""}` : "正在检查全文检索覆盖率。"}</p>{index && (index.missingMessages > 0 || index.coverage < 100) && <button className="text-link task-health-action" disabled={rebuildIndex.isPending} onClick={() => rebuildIndex.mutate()}><RotateCcw size={14} />{rebuildIndex.isPending ? "正在启动…" : "检查并修复索引"}</button>}</div></article>
    </section>
    <section className="content-section task-list-section">
      <div className="section-heading"><div><span className="eyebrow">OPERATION HISTORY</span><h2>后台处理记录</h2><p>进度来自服务端持久化任务，不再由当前弹窗或浏览器页面推测。</p></div><div className="segmented-control task-filters" aria-label="筛选任务">{(["all", "active", "failed", "completed"] as Filter[]).map((value) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{value === "all" ? "全部" : value === "active" ? "进行中" : value === "failed" ? "失败" : "已完成"}</button>)}</div></div>
      {jobs.isLoading ? <LoadingState label="正在读取后台任务" /> : visibleJobs.length ? <div className="task-list">{visibleJobs.map((job) => <article className="task-row" key={job.id}>
        <span className={`task-type-icon ${job.status}`}><ListTodo size={18} /></span>
        <div className="task-copy"><div className="task-title"><span>{typeLabels[job.type]}</span><strong>{job.title || "未命名任务"}</strong></div><p>{job.message || job.phase || "等待处理"}</p>{job.error && <div className="task-error"><XCircle size={14} />{job.error}</div>}<div className="task-meta"><span>{statusLabels[job.status]}</span><span>阶段：{job.phase || "待开始"}</span><span>尝试 {job.attempts}/{job.maxAttempts}</span><time>{formatDate(job.updatedAt)}</time></div></div>
        <div className="task-progress-wrap"><div className="task-progress-label"><span className={`status-badge ${statusTone(job.status)}`}>{statusLabels[job.status]}</span><strong>{Math.max(0, Math.min(100, job.progress))}%</strong></div><div className="task-progress"><i style={{ width: `${Math.max(2, Math.min(100, job.progress))}%` }} /></div><div className="task-actions">{job.resourceId && ["ingestion", "reprocess", "diagram"].includes(job.type) && <button className="text-link" onClick={() => navigate(`/reader/${encodeURIComponent(job.resourceId)}`)}><FileSearch size={14} />查看内容</button>}{job.status === "queued" && <button className="text-link danger-text" disabled={cancel.isPending} onClick={() => cancel.mutate(job.id)}><XCircle size={14} />取消</button>}</div></div>
      </article>)}</div> : <EmptyState icon={<RotateCcw size={28} />} title={filter === "all" ? "还没有后台任务" : "这个状态下没有任务"} description={filter === "all" ? "收到新内容、重新整理或生成智能图解后，处理进度会显示在这里。" : "可以切换筛选条件查看其他任务记录。"} />}
    </section>
  </main>;
}
