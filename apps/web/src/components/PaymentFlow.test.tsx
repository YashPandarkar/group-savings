import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../lib/api";
import { PaymentProvider, usePayment, type PayOutcome } from "./PaymentFlow";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: vi.fn() };
});
const apiMock = vi.mocked(api);

const created = {
  replayed: false,
  order: { id: "ord-1", status: "CREATED" },
  checkout: {
    provider: "simulator", key: "simulator", orderId: "order_sim_1", amount: 20000, currency: "INR",
    name: "Mitra", description: "Group savings deposit", prefill: { name: "Asha", email: "asha@example.com" },
  },
};
const proof = { razorpay_order_id: "order_sim_1", razorpay_payment_id: "pay_1", razorpay_signature: "sig" };

type Scenario = { verifyStatus?: string; pollStatus?: string; verifyError?: Error; createError?: Error };

function setup(s: Scenario = {}) {
  apiMock.mockReset();
  apiMock.mockImplementation((async (path: string) => {
    if (path === "/api/payments/create-order") {
      if (s.createError) throw s.createError;
      return created;
    }
    if (path === "/api/dev/simulator/pay") return { checkout: proof };
    if (path === "/api/payments/verify") {
      if (s.verifyError) throw s.verifyError;
      return { order: { id: "ord-1", status: s.verifyStatus ?? "SUCCESS" } };
    }
    if (path === "/api/payments/ord-1") return { order: { id: "ord-1", status: s.pollStatus ?? "SUCCESS" } };
    throw new Error(`unexpected api call: ${path}`);
  }) as unknown as typeof api);
}

const calledPaths = () => apiMock.mock.calls.map((c) => c[0]);
const optionsOf = (i: number) =>
  apiMock.mock.calls[i][1] as unknown as { headers?: Record<string, string>; body?: Record<string, unknown> };

function Harness({ onDone }: { onDone: (o: PayOutcome) => void }) {
  const { startPayment } = usePayment();
  return (
    <button
      type="button"
      onClick={() =>
        void startPayment({ groupId: "g1", purpose: "MONTHLY_DEPOSIT", amountPaise: 20000, label: "Monthly contribution" }).then(onDone)
      }
    >
      Start
    </button>
  );
}

function renderFlow() {
  const onDone = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PaymentProvider>
        <Harness onDone={onDone} />
      </PaymentProvider>
    </QueryClientProvider>
  );
  return { onDone, user };
}

async function openSimulator(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByText("Simulated payment (test mode). No real money moves.");
}

beforeEach(() => setup());

describe("PaymentFlow", () => {
  it("success: creates an order with an idempotency key, then confirms through the server", async () => {
    const { onDone, user } = renderFlow();
    await openSimulator(user);
    expect(screen.getByRole("heading", { name: "Pay ₹200.00" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pay successfully" }));
    expect(await screen.findByText("Your payment was confirmed and recorded.")).toBeInTheDocument();

    expect(calledPaths()).toEqual(["/api/payments/create-order", "/api/dev/simulator/pay", "/api/payments/verify"]);
    expect(optionsOf(0).headers?.["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(optionsOf(0).body).toEqual({ groupId: "g1", purpose: "MONTHLY_DEPOSIT", amountPaise: 20000 });
    expect(optionsOf(2).body).toEqual(proof);

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("SUCCESS"));
  });

  it("a failed payment records nothing and never asks the server to verify", async () => {
    const { onDone, user } = renderFlow();
    await openSimulator(user);
    await user.click(screen.getByRole("button", { name: "Make the payment fail" }));
    expect(await screen.findByText(/The simulated payment failed/)).toBeInTheDocument();
    expect(calledPaths()).not.toContain("/api/payments/verify");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("FAILED"));
  });

  it("the server's refusal to create the order is shown, and ends as FAILED", async () => {
    setup({ createError: new ApiError(409, "AMOUNT_EXCEEDS_DUE", "Only ₹100.00 is still due.") });
    const { onDone, user } = renderFlow();
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Only ₹100.00 is still due.")).toBeInTheDocument();
    expect(calledPaths()).toEqual(["/api/payments/create-order"]);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("FAILED"));
  });

  it("if the server says the payment isn't a success, the browser doesn't claim it is", async () => {
    setup({ verifyStatus: "FAILED" });
    const { onDone, user } = renderFlow();
    await openSimulator(user);
    await user.click(screen.getByRole("button", { name: "Pay successfully" }));
    expect(await screen.findByText(/could not be confirmed \(failed\)/)).toBeInTheDocument();
    expect(screen.queryByText("Your payment was confirmed and recorded.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("FAILED"));
  });

  it("if verification can't be reached, the person is told not to pay twice (PENDING)", async () => {
    setup({ verifyError: new Error("Network down") });
    const { onDone, user } = renderFlow();
    await openSimulator(user);
    await user.click(screen.getByRole("button", { name: "Pay successfully" }));
    expect(await screen.findByText(/If money was deducted/)).toBeInTheDocument();
    expect(screen.queryByText("Your payment was confirmed and recorded.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("PENDING"));
  });

  it("still pending right after checkout: polls the order and confirms once the server does", async () => {
    setup({ verifyStatus: "PENDING", pollStatus: "SUCCESS" });
    const { user } = renderFlow();
    await openSimulator(user);
    await user.click(screen.getByRole("button", { name: "Pay successfully" }));
    expect(await screen.findByText("Your payment was confirmed and recorded.", {}, { timeout: 6000 })).toBeInTheDocument();
    expect(calledPaths()).toContain("/api/payments/ord-1");
  }, 10_000);

  it("cancelling closes the dialog and reports CANCELLED", async () => {
    const { onDone, user } = renderFlow();
    await openSimulator(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("CANCELLED"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
