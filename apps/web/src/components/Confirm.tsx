import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Button } from "./ui";

type Options = { title: string; message: string; confirmLabel?: string; danger?: boolean };
type Pending = Options & { resolve: (ok: boolean) => void };
type ConfirmFn = (options: Options) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

// Usage:  const confirm = useConfirm();   if (await confirm({ title, message })) { ... }
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    []
  );

  function close(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <h2 id="confirm-title" className="text-lg font-semibold text-slate-900">
              {pending.title}
            </h2>
            <p className="mt-2 text-sm text-slate-600">{pending.message}</p>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button variant={pending.danger ? "danger" : "primary"} onClick={() => close(true)}>
                {pending.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}
