import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../../components/Confirm";
import { ToastProvider } from "../../components/Toast";
import { api } from "../../lib/api";
import type { LoanStatus } from "../../lib/loans";
import { makeLoan } from "../../test/factories";
import LoanActions from "./LoanActions";

vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return { ...actual, api: vi.fn(async () => ({})) };
});
const apiMock = vi.mocked(api);

type Props = ComponentProps<typeof LoanActions>;

function renderActions(over: Partial<Props> & { status?: LoanStatus } = {}) {
  const { status, ...rest } = over;
  const props: Props = {
    loan: makeLoan({ status: status ?? "PENDING" }),
    canReview: false,
    canDecide: false,
    isBorrower: false,
    deciderLabel: "the President",
    ...rest,
  };
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <ConfirmProvider>
          <LoanActions {...props} />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
  return { user };
}

beforeEach(() => apiMock.mockClear());

describe("LoanActions: who sees which buttons", () => {
  it("the borrower can only withdraw their application", () => {
    renderActions({ isBorrower: true });
    expect(screen.getByRole("button", { name: "Withdraw application" })).toBeInTheDocument();
    for (const name of ["Approve", "Reject", "Mark under review"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("a Vice President can mark it under review, but can't decide it, and is told why", () => {
    renderActions({ canReview: true, canDecide: false });
    expect(screen.getByRole("button", { name: "Mark under review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByText(/Only the President can approve, reject or disburse this loan/)).toBeInTheDocument();
  });

  it("the person who decides sees approve and reject, and no review button once it's under review", () => {
    renderActions({ canReview: true, canDecide: true });
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark under review" })).toBeInTheDocument();
  });

  it("an approved loan offers disbursement, not approval", () => {
    renderActions({ status: "APPROVED", canReview: true, canDecide: true });
    expect(screen.getByRole("button", { name: "Record disbursement" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("nothing is offered for a loan that is already running", () => {
    renderActions({ status: "ACTIVE", canReview: true, canDecide: true, isBorrower: false });
    expect(screen.queryByText("Actions")).toBeNull();
  });
});

describe("LoanActions: confirmations and validation", () => {
  it("approving asks first, states the total, and calls the server only after confirmation", async () => {
    const { user } = renderActions({ canReview: true, canDecide: true });
    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Approve this loan?")).toBeInTheDocument();
    expect(within(dialog).getByText(/₹1,040\.00/)).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/loans/loan-1/approve", { method: "POST", body: {} }));
    expect(await screen.findByText("Loan approved.")).toBeInTheDocument();
  });

  it("cancelling the confirmation does nothing", async () => {
    const { user } = renderActions({ canReview: true, canDecide: true });
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(apiMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rejecting needs a real reason before anything is sent", async () => {
    const { user } = renderActions({ canReview: true, canDecide: true });
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.type(screen.getByLabelText("Reason for rejecting"), "short");
    await user.click(screen.getByRole("button", { name: "Reject loan" }));
    expect(screen.getByText("Explain the reason (at least 10 characters)")).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Reason for rejecting"), " and now a proper reason");
    await user.click(screen.getByRole("button", { name: "Reject loan" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    const [path, options] = apiMock.mock.calls[0] as unknown as [string, { body: { reason: string } }];
    expect(path).toBe("/api/loans/loan-1/reject");
    expect(options.body.reason).toContain("a proper reason");
  });
});
