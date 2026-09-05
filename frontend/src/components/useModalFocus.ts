import { useEffect, useRef } from "react";

const focusableSelector = [
  "button:not(:disabled)",
  "[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

type FocusReturnRef = { current: HTMLElement | null };

export function useModalFocus<T extends HTMLElement>({
  open,
  onClose,
  returnFocusRef,
  canClose = true,
}: {
  open: boolean;
  onClose: () => void;
  returnFocusRef?: FocusReturnRef;
  canClose?: boolean;
}) {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  onCloseRef.current = onClose;
  canCloseRef.current = canClose;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const topmost = () => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'));
      return dialogs.at(-1) === dialog;
    };
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
    const focusFrame = window.requestAnimationFrame(() => {
      const initial = dialog.querySelector<HTMLElement>("[data-modal-initial-focus]") || focusable()[0] || dialog;
      initial.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !topmost()) return;
      if (event.key === "Escape") {
        if (!canCloseRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0]!;
      const last = elements.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      const returnTarget = returnFocusRef?.current;
      if (returnTarget?.isConnected) window.requestAnimationFrame(() => returnTarget.focus());
    };
  }, [open, returnFocusRef]);

  return dialogRef;
}
