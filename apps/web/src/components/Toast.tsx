import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type Kind = "success" | "error";
type ToastItem = { id: number; kind: Kind; message: string };
type Toasts = { success: (message: string) => void; error: (message: string) => void };

const ToastContext = createContext<Toasts | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: Kind, message: string) => {
    const id = nextId.current++;
    setItems((list) => [...list, { id, kind, message }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 5000);
  }, []);

  const value = useMemo<Toasts>(
    () => ({ success: (m) => push("success", m), error: (m) => push("error", m) }),
    [push]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-lg px-4 py-3 text-sm text-white shadow-lg ${
              t.kind === "success" ? "bg-green-600" : "bg-red-600"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Toasts {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
