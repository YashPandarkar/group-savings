import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../lib/api";
import { newId } from "../lib/ids";
import { formatPaise } from "../lib/money";
import { Alert, Button, Spinner } from "./ui";

export type PayArgs = {
  groupId: string;
  purpose: "MONTHLY_DEPOSIT" | "ADDITIONAL_DEPOSIT" | "LOAN_REPAYMENT";
  amountPaise: number;
  loanId?: string;
  label: string; // shown in the dialog, e.g. "Monthly contribution"
};
export type PayOutcome = "SUCCESS" | "FAILED" | "CANCELLED" | "PENDING";

type Checkout = {
  provider: "razorpay" | "simulator"; key: string; orderId: string; amount: number; currency: string;
  name: string; description: string; prefill: { name: string; email: string };
};
type CreateOrderResponse = { replayed: boolean; order: { id: string; status: string }; checkout: Checkout };
type OrderResponse = { order: { id: string; status: string } };
type Proof = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };

type View =
  | { step: "creating"; args: PayArgs }
  | { step: "simulator"; args: PayArgs; created: CreateOrderResponse }
  | { step: "razorpay"; args: PayArgs }
  | { step: "confirming"; args: PayArgs }
  | { step: "result"; args: PayArgs; outcome: PayOutcome; message: string };

type PaymentValue = { startPayment: (args: PayArgs) => Promise<PayOutcome> };
const PaymentContext = createContext<PaymentValue | null>(null);

// ───── Razorpay's checkout script (loaded only when it is actually needed) ─────
type RzpInstance = { open: () => void };
type RzpConstructor = new (options: Record<string, unknown>) => RzpInstance;

function loadRazorpay(): Promise<RzpConstructor> {
  const w = window as unknown as { Razorpay?: RzpConstructor };
  if (w.Razorpay) return Promise.resolve(w.Razorpay);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => (w.Razorpay ? resolve(w.Razorpay) : reject(new Error("Razorpay checkout did not load.")));
    script.onerror = () => reject(new Error("Could not load the Razorpay checkout. Check your connection."));
    document.body.appendChild(script);
  });
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function PaymentProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [view, setView] = useState<View | null>(null);
  const resolver = useRef<((o: PayOutcome) => void) | null>(null);
  const outcome = useRef<PayOutcome>("CANCELLED");

  const close = useCallback(() => {
    setView(null);
    resolver.current?.(outcome.current);
    resolver.current = null;
    void qc.invalidateQueries(); // balances, histories, loans: everything may have changed
  }, [qc]);

  const showResult = useCallback((args: PayArgs, o: PayOutcome, message: string) => {
    outcome.current = o;
    setView({ step: "result", args, outcome: o, message });
  }, []);

  // THE BROWSER NEVER DECIDES THAT MONEY ARRIVED. It sends the provider's proof to the server, which
  // verifies the signature, asks the provider's API, and records the payment. We then just read the order status.
  const confirm = useCallback(
    async (args: PayArgs, orderUuid: string, proof: Proof) => {
      setView({ step: "confirming", args });
      try {
        let status = (await api<OrderResponse>("/api/payments/verify", { method: "POST", body: proof })).order.status;
        for (let i = 0; i < 5 && (status === "CREATED" || status === "PENDING"); i++) {
          await wait(2000);
          status = (await api<OrderResponse>(`/api/payments/${orderUuid}`)).order.status;
        }
        if (status === "SUCCESS") {
          showResult(args, "SUCCESS", "Your payment was confirmed and recorded.");
        } else if (status === "CREATED" || status === "PENDING") {
          showResult(args, "PENDING", "The payment provider hasn't confirmed your payment yet. It will appear in your history once confirmed. Please don't pay again.");
        } else {
          showResult(args, "FAILED", `The payment could not be confirmed (${status.toLowerCase()}).`);
        }
      } catch (e) {
        showResult(args, "PENDING", `${errorMessage(e)} If money was deducted, it will be recorded automatically. Check your deposit history before paying again.`);
      }
    },
    [showResult]
  );

  const simulate = useCallback(
    async (args: PayArgs, created: CreateOrderResponse, result: "success" | "fail") => {
      setView({ step: "confirming", args });
      try {
        const res = await api<{ checkout: Proof }>("/api/dev/simulator/pay", {
          method: "POST",
          body: { orderId: created.checkout.orderId, outcome: result, deliverWebhook: false },
        });
        if (result === "fail") {
          showResult(args, "FAILED", "The simulated payment failed. Nothing was recorded. You can try again.");
          return;
        }
        await confirm(args, created.order.id, res.checkout);
      } catch (e) {
        showResult(args, "FAILED", errorMessage(e));
      }
    },
    [confirm, showResult]
  );

  const run = useCallback(
    async (args: PayArgs) => {
      const created = await api<CreateOrderResponse>("/api/payments/create-order", {
        method: "POST",
        headers: { "Idempotency-Key": newId() },
        body: {
          groupId: args.groupId, purpose: args.purpose, amountPaise: args.amountPaise,
          ...(args.loanId ? { loanId: args.loanId } : {}),
        },
      }).catch((e: unknown) => {
        showResult(args, "FAILED", errorMessage(e));
        return null;
      });
      if (!created) return;

      if (created.checkout.provider === "simulator") {
        setView({ step: "simulator", args, created });
        return;
      }

      setView({ step: "razorpay", args });
      try {
        const Razorpay = await loadRazorpay();
        let handled = false;
        const widget = new Razorpay({
          key: created.checkout.key,
          order_id: created.checkout.orderId,
          amount: created.checkout.amount,
          currency: created.checkout.currency,
          name: created.checkout.name,
          description: created.checkout.description,
          prefill: created.checkout.prefill,
          theme: { color: "#4f46e5" },
          handler: (proof: Proof) => {
            handled = true;
            void confirm(args, created.order.id, proof);
          },
          modal: {
            ondismiss: () => {
              if (handled) return;
              outcome.current = "CANCELLED";
              close();
            },
          },
        });
        widget.open();
      } catch (e) {
        showResult(args, "FAILED", errorMessage(e));
      }
    },
    [close, confirm, showResult]
  );

  const startPayment = useCallback(
    (args: PayArgs): Promise<PayOutcome> => {
      if (resolver.current) return Promise.resolve("CANCELLED"); // one payment at a time
      const promise = new Promise<PayOutcome>((resolve) => {
        resolver.current = resolve;
      });
      outcome.current = "CANCELLED";
      setView({ step: "creating", args });
      void run(args);
      return promise;
    },
    [run]
  );

  const value = useMemo(() => ({ startPayment }), [startPayment]);

  return (
    <PaymentContext.Provider value={value}>
      {children}
      {view && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-labelledby="pay-title">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
            <h2 id="pay-title" className="text-lg font-semibold text-slate-900">Pay {formatPaise(view.args.amountPaise)}</h2>
            <p className="mt-1 text-sm text-slate-600">{view.args.label}</p>

            {(view.step === "creating" || view.step === "confirming") && (
              <div className="mt-6 flex items-center gap-3">
                <Spinner />
                <span className="text-sm text-slate-700">
                  {view.step === "creating" ? "Preparing your payment…" : "Confirming your payment with the payment provider…"}
                </span>
              </div>
            )}

            {view.step === "simulator" && (
              <div className="mt-4 space-y-4">
                <Alert kind="warning">Simulated payment (test mode). No real money moves.</Alert>
                <div className="flex flex-col gap-2">
                  <Button onClick={() => void simulate(view.args, view.created, "success")}>Pay successfully</Button>
                  <Button variant="secondary" onClick={() => void simulate(view.args, view.created, "fail")}>Make the payment fail</Button>
                  <Button variant="secondary" onClick={() => { outcome.current = "CANCELLED"; close(); }}>Cancel</Button>
                </div>
              </div>
            )}

            {view.step === "razorpay" && (
              <div className="mt-4 space-y-4">
                <p className="text-sm text-slate-700">Complete the payment in the Razorpay window.</p>
                <Button variant="secondary" onClick={() => { outcome.current = "CANCELLED"; close(); }}>Close</Button>
              </div>
            )}

            {view.step === "result" && (
              <div className="mt-4 space-y-4">
                <Alert kind={view.outcome === "SUCCESS" ? "success" : view.outcome === "PENDING" ? "warning" : "error"}>{view.message}</Alert>
                <Button onClick={close} className="w-full">Close</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </PaymentContext.Provider>
  );
}

export function usePayment(): PaymentValue {
  const ctx = useContext(PaymentContext);
  if (!ctx) throw new Error("usePayment must be used inside <PaymentProvider>");
  return ctx;
}
