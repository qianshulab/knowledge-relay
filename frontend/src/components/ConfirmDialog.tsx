import { AlertTriangle, Check, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  requireText?: string;
};

type PendingConfirmation = ConfirmOptions & { resolve: (value: boolean) => void };
type ConfirmHandler = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmHandler | null>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [verification, setVerification] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const confirm = useCallback<ConfirmHandler>((options) => new Promise((resolve) => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setVerification("");
    setPending({ ...options, resolve });
  }), []);

  const close = useCallback((accepted: boolean) => {
    setPending((current) => {
      current?.resolve(accepted);
      return null;
    });
    setVerification("");
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const value = useMemo(() => confirm, [confirm]);
  const verified = !pending?.requireText || verification === pending.requireText;

  useEffect(() => {
    if (!pending) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTarget = dialogRef.current?.querySelector<HTMLElement>(pending.requireText ? "input" : "[data-confirm-primary]");
    window.setTimeout(() => focusTarget?.focus(), 0);
    return () => { document.body.style.overflow = previousOverflow; };
  }, [pending]);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[href],[tabindex]:not([tabindex="-1"])') || []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <div className="modal-layer confirm-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(false); }}>
          <section ref={dialogRef} className={`confirm-dialog ${pending.tone === "danger" ? "confirm-danger" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description" onKeyDown={handleDialogKeyDown}>
            <button className="icon-button confirm-close" type="button" onClick={() => close(false)} aria-label="关闭确认窗口"><X size={18} /></button>
            <span className="confirm-icon" aria-hidden="true">{pending.tone === "danger" ? <AlertTriangle size={22} /> : <Info size={22} />}</span>
            <div className="confirm-copy">
              <span className="eyebrow">CONFIRM ACTION</span>
              <h2 id="confirm-title">{pending.title}</h2>
              <p id="confirm-description">{pending.description}</p>
            </div>
            {pending.requireText && (
              <label className="confirm-verification">
                <span>请输入 <strong>{pending.requireText}</strong> 继续</span>
                <input autoFocus value={verification} onChange={(event) => setVerification(event.target.value)} autoComplete="off" />
              </label>
            )}
            <footer>
              <button className="button button-secondary" type="button" onClick={() => close(false)}>{pending.cancelLabel || "取消"}</button>
              <button data-confirm-primary className={pending.tone === "danger" ? "button button-destructive" : "button button-primary"} type="button" disabled={!verified} onClick={() => close(true)}><Check size={16} />{pending.confirmLabel || "确认"}</button>
            </footer>
          </section>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmHandler {
  const handler = useContext(ConfirmContext);
  if (!handler) throw new Error("ConfirmDialogProvider is not available");
  return handler;
}
