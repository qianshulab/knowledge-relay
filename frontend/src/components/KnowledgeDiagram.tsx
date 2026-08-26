import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { KnowledgeMap } from "../types";

const colors: Record<string, string> = { root: "#0f766e", resource: "#2563eb", domain: "#7c3aed", concept: "#0891b2", tool: "#d97706", point: "#475569" };
const canvas = { width: 900, height: 540 };
const minimumScale = 0.4;
const maximumScale = 2.5;

type View = { scale: number; x: number; y: number };
type Drag = { pointerId: number; startX: number; startY: number; viewX: number; viewY: number };

export default function KnowledgeDiagram({ diagram }: { diagram: KnowledgeMap }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const positioned = useMemo(() => {
    const root = diagram.nodes.find((node) => node.type === "root") || diagram.nodes[0];
    const others = diagram.nodes.filter((node) => node.id !== root?.id);
    const center = { x: 450, y: 270 };
    const linear = ["flow", "sequence", "state"].includes(diagram.diagramType);
    const timeline = diagram.diagramType === "timeline";
    const comparison = diagram.diagramType === "comparison";
    const nodes = root ? [{ ...root, ...(linear ? { x: 100, y: 270 } : timeline ? { x: 80, y: 120 } : comparison ? { x: 450, y: 86 } : center) }, ...others.map((node, index) => {
      if (linear) {
        const column = index % 4;
        const row = Math.floor(index / 4);
        return { ...node, x: 285 + column * 185, y: 155 + row * 155 };
      }
      if (timeline) {
        const column = index % 5;
        const row = Math.floor(index / 5);
        return { ...node, x: 110 + column * 170, y: 250 + row * 150 };
      }
      if (comparison) {
        const column = index % 3;
        const row = Math.floor(index / 3);
        return { ...node, x: 200 + column * 250, y: 215 + row * 120 };
      }
      const ring = index < 10 ? 170 : 250;
      const ringIndex = index < 10 ? index : index - 10;
      const ringCount = index < 10 ? Math.min(10, others.length) : Math.max(1, others.length - 10);
      const angle = (Math.PI * 2 * ringIndex) / ringCount - Math.PI / 2;
      return { ...node, x: center.x + Math.cos(angle) * ring, y: center.y + Math.sin(angle) * ring };
    })] : [];
    return { nodes, map: new Map(nodes.map((node) => [node.id, node])) };
  }, [diagram]);

  const fit = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const scale = Math.min((frame.clientWidth - 36) / canvas.width, (frame.clientHeight - 36) / canvas.height, 1);
    setView({ scale: Math.max(minimumScale, scale), x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const animation = window.requestAnimationFrame(fit);
    const frame = frameRef.current;
    if (!frame) return () => window.cancelAnimationFrame(animation);
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => {
      window.cancelAnimationFrame(animation);
      observer.disconnect();
    };
  }, [diagram, fit]);

  const zoom = useCallback((nextScale: number, anchor?: { x: number; y: number }) => {
    setView((current) => {
      const scale = Math.min(maximumScale, Math.max(minimumScale, nextScale));
      if (!anchor || !frameRef.current) return { ...current, scale };
      const rect = frameRef.current.getBoundingClientRect();
      const relativeX = anchor.x - rect.left - rect.width / 2;
      const relativeY = anchor.y - rect.top - rect.height / 2;
      const ratio = scale / current.scale;
      return { scale, x: relativeX - (relativeX - current.x) * ratio, y: relativeY - (relativeY - current.y) * ratio };
    });
  }, []);

  useEffect(() => {
    const stage = frameRef.current?.querySelector<HTMLDivElement>(".diagram-stage");
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      zoom(view.scale * factor, { x: event.clientX, y: event.clientY });
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, [view.scale, zoom]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y };
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((current) => ({ ...current, x: drag.viewX + event.clientX - drag.startX, y: drag.viewY + event.clientY - drag.startY }));
  }

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return <div className="diagram-frame" ref={frameRef}>
    <div className="diagram-toolbar" role="group" aria-label="图解缩放控制">
      <button type="button" onClick={() => zoom(view.scale / 1.2)} aria-label="缩小图解" title="缩小"><Minus size={17} /></button>
      <span className="diagram-zoom-value">{Math.round(view.scale * 100)}%</span>
      <button type="button" onClick={() => zoom(view.scale * 1.2)} aria-label="放大图解" title="放大"><Plus size={17} /></button>
      <button type="button" className="diagram-fit" onClick={fit} aria-label="适配窗口" title="适配窗口"><Maximize2 size={16} />适配</button>
    </div>
    <div className={`diagram-stage ${dragging ? "is-dragging" : ""}`} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={finishDrag} onPointerCancel={finishDrag} onDoubleClick={fit}>
      <svg viewBox={`0 0 ${canvas.width} ${canvas.height}`} role="img" aria-label={diagram.diagramLabel || "知识关系图"} style={{ left: `calc(50% + ${view.x}px)`, top: `calc(50% + ${view.y}px)`, transform: `translate(-50%, -50%) scale(${view.scale})` }}>
        {diagram.edges.map((edge, index) => { const a = positioned.map.get(edge.source); const b = positioned.map.get(edge.target); return a && b ? <line key={`${edge.source}-${edge.target}-${index}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} /> : null; })}
        {positioned.nodes.map((node) => <g key={node.id} transform={`translate(${node.x} ${node.y})`}><circle r={node.type === "root" ? 54 : 38} fill={colors[node.type]} /><text textAnchor="middle" dominantBaseline="middle">{node.label.length > 12 ? `${node.label.slice(0, 11)}…` : node.label}</text></g>)}
      </svg>
    </div>
    <span className="diagram-help">滚轮或触控板缩放 · 拖动平移 · 双击适配</span>
  </div>;
}
