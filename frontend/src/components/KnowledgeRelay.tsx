import type { CSSProperties } from "react";
import { FileText, Image, Link2, Sparkles } from "lucide-react";

export default function KnowledgeRelay({ processing = false }: { processing?: boolean }) {
  return <div className={`relay-visual ${processing ? "is-processing" : ""}`} aria-label={processing ? "正在处理收件内容" : "智能处理引擎待命"}>
    <div className="relay-grid" aria-hidden="true" />
    <div className="relay-sources">
      <span><Link2 size={17} />链接</span><span><FileText size={17} />文字</span><span><Image size={17} />附件</span>
    </div>
    <div className="relay-stream relay-stream-in" aria-hidden="true"><i /><i /><i /></div>
    <div className="relay-core">
      <i className="relay-orbit relay-orbit-outer" aria-hidden="true" />
      <i className="relay-orbit relay-orbit-inner" aria-hidden="true" />
      <i className="relay-scan" aria-hidden="true" />
      <span><Sparkles size={22} /></span><strong>Nanobot</strong><small>语义整理引擎</small>
    </div>
    <div className="relay-stream relay-stream-out" aria-hidden="true"><i /><i /></div>
    <div className="relay-output"><span><Sparkles size={15} />知识</span><small>可查阅 · 可检索 · 可同步</small></div>
    <div className="relay-stages" aria-hidden="true">
      <span style={{ "--stage": 0 } as CSSProperties}><i />捕获</span>
      <span style={{ "--stage": 1 } as CSSProperties}><i />解析</span>
      <span style={{ "--stage": 2 } as CSSProperties}><i />理解</span>
      <span style={{ "--stage": 3 } as CSSProperties}><i />入库</span>
    </div>
  </div>;
}
