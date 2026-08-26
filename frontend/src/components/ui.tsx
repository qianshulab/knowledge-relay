import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state">{icon}<strong>{title}</strong><p>{description}</p>{action}</div>;
}

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return <div className="loading-state"><LoaderCircle className="spin" size={22} /><span>{label}</span></div>;
}

export function InlineMessage({ tone = "default", children }: { tone?: "default" | "success" | "danger"; children: ReactNode }) {
  return <div className={`inline-message ${tone}`}>{tone === "success" ? <CheckCircle2 size={18} /> : tone === "danger" ? <AlertCircle size={18} /> : null}<span>{children}</span></div>;
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const processing = ["processing", "pending", "queued"].includes(normalized);
  const failed = ["failed", "error"].includes(normalized);
  return <span className={`status-badge ${processing ? "processing" : failed ? "danger" : "success"}`}>{processing ? "整理中" : failed ? "待重试" : "已整理"}</span>;
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
