import type { CSSProperties } from "react";
import { FileText, Image, Link2, Network, Sparkles } from "lucide-react";

export default function KnowledgeRelay({ processing = false, mode = "knowledge" }: { processing?: boolean; mode?: "knowledge" | "diagram" }) {
  const diagramMode = mode === "diagram";
  return <div className={`relay-visual ${processing ? "is-processing" : ""}`} aria-label={processing ? (diagramMode ? "正在生成智能图解" : "正在处理收件内容") : "智能处理引擎待命"}>
    <div className="relay-grid" aria-hidden="true" />
    <div className="relay-sources">
      {diagramMode ? <><span><FileText size={17} />结构</span><span><Sparkles size={17} />要点</span><span><Link2 size={17} />关系</span></> : <><span><Link2 size={17} />链接</span><span><FileText size={17} />文字</span><span><Image size={17} />附件</span></>}
    </div>
    <div className="relay-stream relay-stream-in" aria-hidden="true"><i /><i /><i /></div>
    <div className="relay-core">
      <i className="relay-orbit relay-orbit-outer" aria-hidden="true" />
      <i className="relay-orbit relay-orbit-inner" aria-hidden="true" />
      <i className="relay-scan" aria-hidden="true" />
      <span><Sparkles size={22} /></span><strong>Nanobot</strong><small>{diagramMode ? "图解生成引擎" : "语义整理引擎"}</small>
    </div>
    <div className="relay-stream relay-stream-out" aria-hidden="true"><i /><i /></div>
    <div className="relay-output"><span>{diagramMode ? <Network size={15} /> : <Sparkles size={15} />}{diagramMode ? "图解" : "知识"}</span><small>{diagramMode ? "可查看 · 可缩放 · 已缓存" : "可查阅 · 可检索 · 可同步"}</small></div>
    <div className="relay-stages" aria-hidden="true">
      {(diagramMode ? ["读取", "选图", "绘制", "保存"] : ["捕获", "解析", "理解", "入库"]).map((label, index) => <span key={label} style={{ "--stage": index } as CSSProperties}><i />{label}</span>)}
    </div>
  </div>;
}
