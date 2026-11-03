import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

interface ModalProps {
  title: string;
  /** Called on Escape and on backdrop click, unless `dismissible` is false. */
  onClose: () => void;
  /** Set false while work is in flight so Escape/backdrop can't close the dialog. */
  dismissible?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * daisyUI modal on a native <dialog> (focus trapping and Escape for free). Mount it to open it.
 * Mark the element to focus first with `data-autofocus`; React's `autoFocus` fires before
 * the dialog is open and has no effect.
 */
export function Modal({ title, onClose, dismissible = true, className = "", children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => opener?.focus();
  }, []);

  const requestClose = () => {
    if (dismissible) onClose();
  };

  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault(); // let React state, not the browser, close it
        requestClose();
      }}
    >
      <div className={`modal-box ${className}`}>
        <h3 className="mb-4 text-lg font-semibold">{title}</h3>
        {children}
      </div>
      <div className="modal-backdrop" onClick={requestClose} />
    </dialog>
  );
}
