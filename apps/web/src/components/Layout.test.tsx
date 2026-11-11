import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Role } from "../lib/types";
import Layout from "./Layout";

const auth = vi.hoisted(() => ({ role: "MEMBER" as string }));

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    me: {
      user: { id: "u1", email: "asha@example.com", name: "Asha" },
      membership: { groupId: "g1", groupName: "Mitra Savings Circle", role: auth.role },
    },
    logout: vi.fn(),
  }),
}));
vi.mock("../lib/api", () => ({ api: vi.fn(async () => ({ unread: 3 })) }));

function renderLayout(role: Role) {
  auth.role = role;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Layout />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Layout navigation", () => {
  it("an ordinary member has no Reports link", () => {
    renderLayout("MEMBER");
    expect(screen.queryByRole("link", { name: "Reports" })).toBeNull();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });

  it("the President and the Vice President do", () => {
    renderLayout("PRESIDENT");
    expect(screen.getByRole("link", { name: "Reports" })).toBeInTheDocument();
  });

  it("the Vice President sees Reports too", () => {
    renderLayout("VICE_PRESIDENT");
    expect(screen.getByRole("link", { name: "Reports" })).toBeInTheDocument();
  });

  it("shows the unread notification count", async () => {
    renderLayout("MEMBER");
    expect((await screen.findAllByText("3")).length).toBeGreaterThan(0);
  });
});
