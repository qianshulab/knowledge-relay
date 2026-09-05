import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Clock3, LoaderCircle, RotateCcw } from "lucide-react";

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header"><div className="page-header-copy">{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-state-icon">{icon}</span><strong>{title}</strong><p>{description}</p>{action && <div className="empty-state-action">{action}</div>}</div>;
}

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return <div className="loading-state" role="status" aria-live="polite"><span className="loading-state-mark"><LoaderCircle className="spin" size={18} /></span><span>{label}</span><span className="loading-state-lines" aria-hidden="true"><i /><i /><i /></span></div>;
}

export function InlineMessage({ tone = "default", children }: { tone?: "default" | "success" | "warning" | "danger"; children: ReactNode }) {
  return <div className={`inline-message ${tone}`} role={tone === "danger" ? "alert" : "status"}>{tone === "success" ? <CheckCircle2 size={18} /> : tone === "warning" ? <Clock3 size={18} /> : tone === "danger" ? <AlertCircle size={18} /> : null}<span>{children}</span></div>;
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const queued = ["pending", "queued"].includes(normalized);
  const processing = normalized === "processing";
  const retrying = normalized === "retrying";
  const failed = ["failed", "error"].includes(normalized);
  const fallback = normalized === "fallback";
  const tone = failed ? "danger" : retrying || fallback ? "warning" : processing || queued ? "processing" : "success";
  const label = failed ? "处理失败" : retrying ? "自动重试" : fallback ? "基础整理" : processing ? "正在整理" : queued ? "等待整理" : "已整理";
  return <span className={`status-badge ${tone}`}>{processing ? <LoaderCircle className="spin" size={11} /> : retrying ? <RotateCcw size={11} /> : null}{label}</span>;
}

export function formatDate(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function formatBytes(size = 0) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

export const formatLabels: Record<string, string> = {
  wechat_article: "微信公众号文章", web_article: "网页文章", document: "文档", image: "图片素材", audio: "音频", video: "视频", mixed: "混合内容", text: "文字笔记",
};
