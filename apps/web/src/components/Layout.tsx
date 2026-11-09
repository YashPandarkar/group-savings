import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { isAdmin, ROLE_LABEL } from "../lib/types";
import { Button } from "./ui";

const NAV = [
  { to: "/", label: "Dashboard", end: true, adminOnly: false },
  { to: "/members", label: "Members", end: false, adminOnly: false },
  { to: "/deposits", label: "Deposits", end: false, adminOnly: false },
  { to: "/loans", label: "Loans", end: false, adminOnly: false },
  { to: "/withdrawals", label: "Withdrawals", end: false, adminOnly: false },
  { to: "/transactions", label: "Transactions", end: false, adminOnly: false },
  { to: "/reports", label: "Reports", end: false, adminOnly: true },
  { to: "/settings", label: "Settings", end: false, adminOnly: false },
];

export default function Layout() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const role = me?.membership?.role;
  const links = NAV.filter((n) => !n.adminOnly || isAdmin(role));

  return (
    <div className="min-h-screen md:flex">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
        <span className="font-semibold text-slate-900">{me?.membership?.groupName}</span>
        <button
          type="button"
          aria-label="Toggle menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="rounded-lg p-2 text-slate-700 ring-1 ring-slate-300"
        >
          ☰
        </button>
      </header>

      <aside
        className={`${open ? "block" : "hidden"} border-b border-slate-200 bg-white md:flex md:min-h-screen md:w-64 md:flex-col md:border-b-0 md:border-r`}
      >
        <div className="hidden px-5 py-6 md:block">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Group Savings</p>
          <p className="mt-1 text-lg font-bold text-slate-900">{me?.membership?.groupName}</p>
        </div>

        <nav className="flex flex-col gap-1 px-3 pb-4" aria-label="Main">
          {links.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 text-sm font-medium ${
                  isActive ? "bg-indigo-50 text-indigo-700" : "text-slate-700 hover:bg-slate-100"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto border-t border-slate-200 p-4">
          <p className="text-sm font-medium text-slate-900">{me?.user.name}</p>
          <p className="text-xs text-slate-500">{role ? ROLE_LABEL[role] : ""}</p>
          <Button variant="secondary" className="mt-3 w-full" onClick={() => void logout()}>
            Log out
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
        <Outlet />
      </main>
    </div>
  );
}
