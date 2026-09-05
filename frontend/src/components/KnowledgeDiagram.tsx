import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, Minus, Plus, Search, X } from "lucide-react";
import type { KnowledgeMap, KnowledgeMapNode } from "../types";

const colors: Record<KnowledgeMapNode["type"], string> = {
  root: "var(--primary-solid)", resource: "var(--primary-solid)", domain: "var(--accent)", concept: "var(--info)", tool: "var(--warning)", point: "var(--text-muted)",
};
const minimumScale = 0.35;
const maximumScale = 2.5;
type View = { scale: number; x: number; y: number };
type Drag = { pointerId: number; startX: number; startY: number; viewX: number; viewY: number };
type VisualRole = NonNullable<KnowledgeMapNode["role"]>;
type PositionedNode = KnowledgeMapNode & { x: number; y: number; width: number; height: number; order: number; role: VisualRole };

function orderedNodes(diagram: KnowledgeMap, rootId: string): KnowledgeMapNode[] {
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  const next = new Map<string, string[]>();
  for (const edge of diagram.edges) next.set(edge.source, [...(next.get(edge.source) || []), edge.target]);
  const result: KnowledgeMapNode[] = [];
  const seen = new Set([rootId]);
  const queue = [...(next.get(rootId) || [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) result.push(node);
    queue.push(...(next.get(id) || []));
  }
  result.push(...diagram.nodes.filter((node) => !seen.has(node.id)));
  return result;
}

function inferRole(node: KnowledgeMapNode, diagram: KnowledgeMap, order: number, total: number): VisualRole {
  if (node.role) return node.role;
  if (node.type === "root" || node.type === "resource") return ["flow", "sequence", "state"].includes(diagram.diagramType) ? "start" : "topic";
  if (/(?:判断|是否|检查|验证|选择|条件|分支)/.test(node.label)) return "decision";
  if (diagram.diagramType === "timeline") return "milestone";
  if (diagram.diagramType === "sequence") return "actor";
  if (diagram.diagramType === "comparison") return "artifact";
  if (["flow", "state"].includes(diagram.diagramType) && order === total - 1) return "result";
  return ["flow", "state"].includes(diagram.diagramType) ? "process" : node.type === "tool" ? "artifact" : "topic";
}

function place(node: KnowledgeMapNode, diagram: KnowledgeMap, order: number, total: number, x: number, y: number): PositionedNode {
  const root = node.type === "root" || node.type === "resource";
  return { ...node, x, y, width: root ? 218 : 188, height: root ? 88 : 76, order, role: inferRole(node, diagram, order, total) };
}

function layoutDiagram(diagram: KnowledgeMap) {
  const root = diagram.nodes.find((node) => node.type === "root" || node.type === "resource") || diagram.nodes[0];
  if (!root) return { width: 900, height: 540, nodes: [] as PositionedNode[], map: new Map<string, PositionedNode>() };
  const all = [root, ...orderedNodes(diagram, root.id)];
  const linear = ["flow", "sequence", "state", "timeline"].includes(diagram.diagramType);
  const comparison = diagram.diagramType === "comparison";
  let width = 1100;
  let height = 650;
  let nodes: PositionedNode[];
  if (linear) {
    const perRow = Math.min(4, Math.max(3, Math.ceil(Math.sqrt(all.length))));
    const columns = Math.min(perRow, all.length);
    const rows = Math.ceil(all.length / perRow);
    width = Math.max(1030, columns * 245 + 120);
    height = Math.max(560, rows * 168 + 180);
    nodes = all.map((node, index) => {
      const row = Math.floor(index / perRow);
      const position = index % perRow;
      const column = row % 2 === 0 ? position : perRow - 1 - position;
      return place(node, diagram, index, all.length, 150 + column * 245, 140 + row * 168);
    });
  } else if (comparison) {
    const others = all.slice(1);
    const groups = [...new Set(others.map((node) => node.group || "其他"))];
    const columnCount = Math.max(2, Math.min(4, groups.length));
    const grouped = groups.map((group) => ({ group, nodes: others.filter((node) => (node.group || "其他") === group) }));
    const maxRows = Math.max(1, ...grouped.map((group) => group.nodes.length));
    width = Math.max(1050, columnCount * 270 + 120);
    height = Math.max(620, Math.ceil(groups.length / columnCount) * (maxRows * 132 + 90) + 210);
    const placed: PositionedNode[] = [place(root, diagram, 0, all.length, width / 2, 92)];
    let order = 1;
    grouped.forEach((group, groupIndex) => {
      const column = groupIndex % columnCount;
      const blockRow = Math.floor(groupIndex / columnCount);
      group.nodes.forEach((node, index) => placed.push(place(node, diagram, order++, all.length, 190 + column * 270, 240 + blockRow * (maxRows * 132 + 90) + index * 132)));
    });
    nodes = placed;
  } else {
    const others = all.slice(1);
    const ringOneCount = Math.min(8, others.length);
    const ringTwoCount = Math.max(0, others.length - ringOneCount);
    width = ringTwoCount ? 1380 : 1120;
    height = ringTwoCount ? 920 : 720;
    const center = { x: width / 2, y: height / 2 };
    nodes = [place(root, diagram, 0, all.length, center.x, center.y), ...others.map((node, index) => {
      const outer = index >= ringOneCount;
      const ringIndex = outer ? index - ringOneCount : index;
      const count = outer ? ringTwoCount : ringOneCount;
      const angle = (Math.PI * 2 * ringIndex) / Math.max(1, count) - Math.PI / 2;
      const radiusX = outer ? 525 : 340;
      const radiusY = outer ? 350 : 235;
      return place(node, diagram, index + 1, all.length, center.x + Math.cos(angle) * radiusX, center.y + Math.sin(angle) * radiusY);
    })];
  }
  return { width, height, nodes, map: new Map(nodes.map((node) => [node.id, node])) };
}

function labelLines(label: string, limit = 14): string[] {
  if (label.length <= limit) return [label];
  return [label.slice(0, limit), `${label.slice(limit, limit * 2 - 1)}${label.length > limit * 2 - 1 ? "…" : ""}`];
}

function edgePath(source: PositionedNode, target: PositionedNode): string {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const direction = dx >= 0 ? 1 : -1;
    const x1 = source.x + direction * source.width / 2;
    const x2 = target.x - direction * target.width / 2;
    const middle = (x1 + x2) / 2;
    return `M ${x1} ${source.y} C ${middle} ${source.y}, ${middle} ${target.y}, ${x2} ${target.y}`;
  }
  const direction = dy >= 0 ? 1 : -1;
  const y1 = source.y + direction * source.height / 2;
  const y2 = target.y - direction * target.height / 2;
  const middle = (y1 + y2) / 2;
  return `M ${source.x} ${y1} C ${source.x} ${middle}, ${target.x} ${middle}, ${target.x} ${y2}`;
}

const roleNames: Record<VisualRole, string> = {
  start: "起点", process: "步骤", decision: "判断", result: "结果", actor: "参与者", artifact: "对象", milestone: "节点", topic: "主题",
};

export default function KnowledgeDiagram({ diagram }: { diagram: KnowledgeMap }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const selectedTriggerRef = useRef<SVGGElement | null>(null);
  const markerId = `diagram-arrow-${useId().replace(/:/g, "")}`;
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const positioned = useMemo(() => layoutDiagram(diagram), [diagram]);
  const selected = positioned.map.get(selectedId || "");
  const matchingIds = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return new Set<string>();
    return new Set(positioned.nodes.filter((node) => [node.label, node.description, node.evidence, node.group].some((text) => text?.toLowerCase().includes(value))).map((node) => node.id));
  }, [positioned.nodes, query]);
  const selectedEdges = useMemo(() => diagram.edges.filter((edge) => edge.source === selectedId || edge.target === selectedId), [diagram.edges, selectedId]);

  const constrainView = useCallback((next: View): View => {
    const stage = stageRef.current;
    if (!stage) return next;
    const horizontalLimit = Math.max(72, (positioned.width * next.scale - stage.clientWidth) / 2 + 120);
    const verticalLimit = Math.max(72, (positioned.height * next.scale - stage.clientHeight) / 2 + 120);
    return {
      ...next,
      x: Math.max(-horizontalLimit, Math.min(horizontalLimit, next.x)),
      y: Math.max(-verticalLimit, Math.min(verticalLimit, next.y)),
    };
  }, [positioned.height, positioned.width]);

  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const scale = Math.min((stage.clientWidth - 56) / positioned.width, (stage.clientHeight - 64) / positioned.height, 1);
    setView({ scale: Math.max(minimumScale, scale), x: 0, y: 12 });
  }, [positioned.height, positioned.width]);

  useEffect(() => {
    const animation = window.requestAnimationFrame(fit);
    const stage = stageRef.current;
    if (!stage) return () => window.cancelAnimationFrame(animation);
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => { window.cancelAnimationFrame(animation); observer.disconnect(); };
  }, [diagram, fit]);

  const zoom = useCallback((nextScale: number, anchor?: { x: number; y: number }) => {
    setView((current) => {
      const scale = Math.min(maximumScale, Math.max(minimumScale, nextScale));
      if (!anchor || !stageRef.current) return constrainView({ ...current, scale });
      const rect = stageRef.current.getBoundingClientRect();
      const relativeX = anchor.x - rect.left - rect.width / 2;
      const relativeY = anchor.y - rect.top - rect.height / 2;
      const ratio = scale / current.scale;
      return constrainView({ scale, x: relativeX - (relativeX - current.x) * ratio, y: relativeY - (relativeY - current.y) * ratio });
    });
  }, [constrainView]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => { event.preventDefault(); zoom(view.scale * (event.deltaY < 0 ? 1.12 : 0.89), { x: event.clientX, y: event.clientY }); };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [view.scale, zoom]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest(".diagram-node")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y };
    setDragging(true);
  }
  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((current) => constrainView({ ...current, x: drag.viewX + event.clientX - drag.startX, y: drag.viewY + event.clientY - drag.startY }));
  }
  function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function selectNode(id: string, trigger?: SVGGElement) {
    const closing = selectedId === id;
    if (closing) {
      setSelectedId(undefined);
      return;
    }
    if (trigger) selectedTriggerRef.current = trigger;
    setSelectedId(id);
    window.requestAnimationFrame(() => panelRef.current?.focus());
  }

  function closeNodePanel() {
    setSelectedId(undefined);
    window.requestAnimationFrame(() => selectedTriggerRef.current?.focus());
  }

  function handleStageKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && selectedId) {
      event.preventDefault();
      event.stopPropagation();
      closeNodePanel();
      return;
    }
    if ((event.target as Element).closest(".diagram-node")) return;
    if (["+", "="].includes(event.key)) {
      event.preventDefault();
      zoom(view.scale * 1.2);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(view.scale / 1.2);
    } else if (event.key === "0") {
      event.preventDefault();
      fit();
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const amount = event.shiftKey ? 72 : 28;
      setView((current) => constrainView({
        ...current,
        x: current.x + (event.key === "ArrowLeft" ? amount : event.key === "ArrowRight" ? -amount : 0),
        y: current.y + (event.key === "ArrowUp" ? amount : event.key === "ArrowDown" ? -amount : 0),
      }));
    }
  }

  return <div className="diagram-frame" ref={frameRef}>
    <label className="diagram-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="在图解中查找" aria-label={query.trim() ? `在图解中查找，找到 ${matchingIds.size} 个节点` : "在图解中查找"} />{query && !matchingIds.size ? <span className="diagram-search-empty" role="status">未找到</span> : null}{query && <button type="button" onClick={() => setQuery("")} aria-label="清除图解搜索"><X size={14} /></button>}</label>
    <div className="diagram-toolbar" role="group" aria-label="图解缩放控制"><button type="button" disabled={view.scale <= minimumScale + 0.001} onClick={() => zoom(view.scale / 1.2)} aria-label="缩小图解" title="缩小"><Minus size={17} /></button><span className="diagram-zoom-value">{Math.round(view.scale * 100)}%</span><button type="button" disabled={view.scale >= maximumScale - 0.001} onClick={() => zoom(view.scale * 1.2)} aria-label="放大图解" title="放大"><Plus size={17} /></button><button type="button" className="diagram-fit" onClick={fit} aria-label="适配窗口" title="适配窗口"><Maximize2 size={16} />适配</button></div>
    <div ref={stageRef} className={`diagram-stage ${dragging ? "is-dragging" : ""}`} tabIndex={0} aria-label="交互式智能图解。可用加减键缩放、方向键平移、数字 0 适配窗口。" onKeyDown={handleStageKeyDown} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={finishDrag} onPointerCancel={finishDrag} onDoubleClick={(event) => { if (!(event.target as Element).closest(".diagram-node")) fit(); }}>
      <svg viewBox={`0 0 ${positioned.width} ${positioned.height}`} role="img" aria-label={diagram.diagramLabel || "知识关系图"} style={{ width: positioned.width, height: positioned.height, left: `calc(50% + ${view.x}px)`, top: `calc(50% + ${view.y}px)`, transform: `translate(-50%, -50%) scale(${view.scale})` }}>
        <defs><marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: "var(--text-muted)" }} /></marker></defs>
        {diagram.edges.map((edge, index) => { const a = positioned.map.get(edge.source); const b = positioned.map.get(edge.target); if (!a || !b) return null; const active = Boolean(selectedId && (edge.source === selectedId || edge.target === selectedId)); const dimmed = Boolean(selectedId && !active); const midX = (a.x + b.x) / 2; const midY = (a.y + b.y) / 2; return <g className={`diagram-edge ${edge.kind === "secondary" ? "is-secondary" : ""} ${active ? "is-active" : ""} ${dimmed ? "is-dimmed" : ""}`} key={`${edge.source}-${edge.target}-${index}`}><path d={edgePath(a, b)} markerEnd={`url(#${markerId})`} />{edge.label && <text className="diagram-edge-label" x={midX} y={midY - 7} textAnchor="middle">{edge.label.slice(0, 12)}</text>}</g>; })}
        {positioned.nodes.map((node) => {
          const matched = !query.trim() || matchingIds.has(node.id);
          const related = !selectedId || selectedId === node.id || selectedEdges.some((edge) => edge.source === node.id || edge.target === node.id);
          const isRoot = node.type === "root" || node.type === "resource";
          const lines = labelLines(node.label, isRoot ? 16 : 13);
          const style = { "--node-accent": colors[node.type] } as CSSProperties;
          return <g key={node.id} style={style} className={`diagram-node role-${node.role} ${isRoot ? "is-root" : ""} ${selectedId === node.id ? "is-selected" : ""} ${!matched || !related ? "is-dimmed" : ""}`} transform={`translate(${node.x} ${node.y})`} role="button" tabIndex={0} aria-label={`${node.label}${node.description ? `：${node.description}` : ""}`} aria-expanded={selectedId === node.id} aria-controls={selectedId === node.id ? "diagram-node-detail" : undefined} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); selectNode(node.id, event.currentTarget); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(node.id, event.currentTarget); } }}>
            <rect className="diagram-node-card" x={-node.width / 2} y={-node.height / 2} width={node.width} height={node.height} rx={node.role === "decision" ? 18 : 13} />
            <rect className="diagram-node-accent" x={-node.width / 2} y={-node.height / 2} width="6" height={node.height} rx="3" />
            <circle className="diagram-node-index" cx={-node.width / 2 + 22} cy={-node.height / 2 + 21} r="11" />
            <text className="diagram-node-index-label" x={-node.width / 2 + 22} y={-node.height / 2 + 25} textAnchor="middle">{isRoot ? "◆" : node.order}</text>
            <text className="diagram-node-role" x={-node.width / 2 + 40} y={-node.height / 2 + 25}>{node.group || roleNames[node.role]}</text>
            {lines.map((line, index) => <text className="diagram-node-label" key={`${line}-${index}`} x={-node.width / 2 + 18} y={9 + index * 17}>{line}</text>)}
          </g>;
        })}
      </svg>
    </div>
    {selected && <aside ref={panelRef} id="diagram-node-detail" className="diagram-node-panel" role="region" tabIndex={-1} aria-live="polite" aria-label={`${selected.label}的节点解释`} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeNodePanel(); } }}><button type="button" onClick={closeNodePanel} aria-label="关闭节点详情"><X size={15} /></button><span>{roleNames[selected.role]}{selected.group ? ` · ${selected.group}` : ""}</span><h3>{selected.label}</h3>{selected.description ? <p>{selected.description}</p> : <p>该节点来自资料结构，暂时没有更详细的说明。</p>}{selected.evidence && <blockquote><strong>资料依据</strong>{selected.evidence}</blockquote>}{selectedEdges.length > 0 && <div>{selectedEdges.slice(0, 5).map((edge, index) => { const otherId = edge.source === selected.id ? edge.target : edge.source; const other = positioned.map.get(otherId); return other ? <button key={`${otherId}-${index}`} type="button" onClick={() => { setSelectedId(otherId); window.requestAnimationFrame(() => panelRef.current?.focus()); }}>{edge.label || "关联"} · {other.label}</button> : null; })}</div>}</aside>}
    <span className="diagram-help">点击卡片查看解释 · 滚轮缩放 · 拖动平移 · 双击适配</span>
  </div>;
}
