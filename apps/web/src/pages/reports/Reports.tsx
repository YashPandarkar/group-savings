import { useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { Alert, PageHeader } from "../../components/ui";
import { isAdmin } from "../../lib/types";
import FundTab from "./FundTab";
import IntegrityTab from "./IntegrityTab";
import LoansTab from "./LoansTab";
import MonthlyTab from "./MonthlyTab";
import WithdrawalsTab from "./WithdrawalsTab";

const TABS = [
  { id: "fund", label: "Fund and savings" },
  { id: "monthly", label: "Monthly and annual" },
  { id: "loans", label: "Loans" },
  { id: "withdrawals", label: "Withdrawals" },
  { id: "integrity", label: "Books check" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function Reports() {
  const { me } = useAuth();
  const [tab, setTab] = useState<TabId>("fund");

  if (!isAdmin(me!.membership!.role)) {
    return (
      <>
        <PageHeader title="Reports" />
        <Alert kind="info">Reports are for the President and Vice President. You can see your own records on the Transactions page.</Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Reports" subtitle="Figures come from the group's ledger, not from a bank." />
      <div role="tablist" aria-label="Reports" className="mb-6 flex flex-wrap gap-2 border-b border-slate-200 pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-2 text-sm font-medium ${tab === t.id ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "fund" && <FundTab />}
      {tab === "monthly" && <MonthlyTab />}
      {tab === "loans" && <LoansTab />}
      {tab === "withdrawals" && <WithdrawalsTab />}
      {tab === "integrity" && <IntegrityTab />}
    </>
  );
}
