import type { CSSProperties } from "react";
import { FileText, Image, Link2, Network, Sparkles } from "lucide-react";

type RelayMode = "knowledge" | "diagram";
type RelayPhase = "analyzing" | "saving";

export default function KnowledgeRelay({ processing = false, mode = "knowledge", phase }: { processing?: boolean; mode?: RelayMode; phase?: RelayPhase }) {
  const diagramMode = mode === "diagram";
  const stages = diagramMode ? ["读取", "选图", "绘制", "保存"] : ["捕获", "解析", "理解", "入库"];
  const activeStage = processing ? diagramMode ? phase === "saving" ? 3 : 1 : -1 : -1;
  const status = processing
    ? diagramMode
      ? phase === "saving" ? "图解结构已完成，正在保存" : "正在分析资料并生成智能图解"
      : "正在理解收件内容并写入知识库"
    : "智能处理引擎待命";
  return <div className={`relay-visual ${processing ? "is-processing" : ""}`} data-mode={mode} data-phase={phase || (processing ? "processing" : "idle")} role="status" aria-live="polite" aria-label={status}>
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
    <div className="relay-output"><span>{diagramMode ? <Network size={15} /> : <Sparkles size={15} />}{diagramMode ? "图解" : "知识"}</span><small>{diagramMode ? processing ? phase === "saving" ? "正在保存并缓存" : "正在分析与绘制" : "可查看 · 可缩放 · 已缓存" : processing ? "正在整理与建立索引" : "可查阅 · 可检索 · 可同步"}</small></div>
    <div className="relay-stages" aria-hidden="true">
      {stages.map((label, index) => <span key={label} className={activeStage >= 0 ? index < activeStage ? "is-complete" : index === activeStage ? "is-current" : "" : ""} style={{ "--stage": index } as CSSProperties}><i />{label}</span>)}
    </div>
  </div>;
}
