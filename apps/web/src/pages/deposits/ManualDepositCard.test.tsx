import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { ApiError, api } from "../../lib/api";
import ManualDepositCard from "./ManualDepositCard";

vi.mock("../../auth/AuthContext", () => ({
  useAuth: () => ({
    me: {
      user: { id: "u-admin", email: "priya@example.com", name: "Priya" },
      membership: { groupId: "g1", groupName: "Mitra", role: "PRESIDENT" },
    },
  }),
}));
vi.mock("../../lib/queries", () => ({
  useMembers: () => ({
    data: {
      members: [
        { id: "m-admin", userId: "u-admin", name: "Priya", role: "PRESIDENT", status: "ACTIVE", joinedAt: "2026-01-01T00:00:00Z" },
        { id: "m-rahul", userId: "u-rahul", name: "Rahul", role: "MEMBER", status: "ACTIVE", joinedAt: "2026-01-01T00:00:00Z" },
      ],
    },
  }),
}));
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return { ...actual, api: vi.fn() };
});
const apiMock = vi.mocked(api);

const bodyOf = (i: number) =>
  (apiMock.mock.calls[i][1] as unknown as { body: Record<string, unknown> }).body;

function renderCard() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <ManualDepositCard groupId="g1" />
      </ToastProvider>
    </QueryClientProvider>
  );
  return { user };
}

async function fillValid(user: ReturnType<typeof userEvent.setup>, amount: string) {
  await user.type(screen.getByLabelText("Amount (₹)"), amount);
  await user.type(screen.getByLabelText("Evidence note"), "Cash received at the meeting");
}

beforeEach(() => apiMock.mockReset());

describe("ManualDepositCard", () => {
  it("can't record a deposit for yourself: you aren't in the member list", () => {
    renderCard();
    const select = screen.getByLabelText("Member");
    expect(select).toHaveTextContent("Rahul");
    expect(select).not.toHaveTextContent("Priya");
  });

  it("checks the form before sending anything", async () => {
    const { user } = renderCard();
    await user.click(screen.getByRole("button", { name: "Record deposit" }));
    expect(screen.getByText("Choose a member")).toBeInTheDocument();
    expect(screen.getByText(/Enter an amount from ₹1 to ₹10,00,000/)).toBeInTheDocument();
    expect(screen.getByText(/Describe the evidence/)).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("a non-cash deposit needs the bank's transaction reference", async () => {
    const { user } = renderCard();
    await user.selectOptions(screen.getByLabelText("Member"), "u-rahul");
    await user.selectOptions(screen.getByLabelText("Method"), "UPI");
    await fillValid(user, "200");
    await user.click(screen.getByRole("button", { name: "Record deposit" }));
    expect(screen.getByText("Enter the UTR / transaction ID")).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("keeps ONE request id across failed retries, and uses a fresh one after a success", async () => {
    apiMock.mockRejectedValueOnce(new ApiError(503, "PROVIDER_UNAVAILABLE", "Server busy"));
    apiMock.mockResolvedValueOnce({ replayed: false });
    apiMock.mockResolvedValueOnce({ replayed: false });
    const { user } = renderCard();

    await user.selectOptions(screen.getByLabelText("Member"), "u-rahul");
    await fillValid(user, "200");
    await user.click(screen.getByRole("button", { name: "Record deposit" }));
    expect(await screen.findByText("Server busy")).toBeInTheDocument();

    // The form kept its values, so a retry is one click, and it carries the SAME request id.
    await user.click(screen.getByRole("button", { name: "Record deposit" }));
    expect(await screen.findByText("Deposit recorded.")).toBeInTheDocument();

    // A new deposit afterwards must get a NEW id.
    await fillValid(user, "300");
    await user.click(screen.getByRole("button", { name: "Record deposit" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(3));

    expect(bodyOf(0)).toMatchObject({ userId: "u-rahul", amountPaise: 20000, method: "CASH", evidenceNote: "Cash received at the meeting" });
    expect(bodyOf(0)).not.toHaveProperty("paymentReference");
    expect(bodyOf(0).clientRequestId).toBeTruthy();
    expect(bodyOf(1).clientRequestId).toBe(bodyOf(0).clientRequestId);
    expect(bodyOf(2).clientRequestId).not.toBe(bodyOf(1).clientRequestId);
    expect(bodyOf(2).amountPaise).toBe(30000);
  });
});
