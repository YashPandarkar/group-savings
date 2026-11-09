import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import TestModeBanner from "./components/TestModeBanner";
import { RequireAuth, RequireGroup } from "./components/guards";
import { ComingSoon, NotFound } from "./pages/ComingSoon";
import Dashboard from "./pages/Dashboard";
import MemberDetail from "./pages/MemberDetail";
import Members from "./pages/Members";
import Notifications from "./pages/Notifications";
import Welcome from "./pages/Welcome";
import AcceptInvitation from "./pages/auth/AcceptInvitation";
import ForgotPassword from "./pages/auth/ForgotPassword";
import Login from "./pages/auth/Login";
import Register from "./pages/auth/Register";
import ResetPassword from "./pages/auth/ResetPassword";
import VerifyEmail from "./pages/auth/VerifyEmail";
import Settings from "./pages/settings/Settings";

export default function App() {
  return (
    <>
      <TestModeBanner />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/accept-invitation" element={<AcceptInvitation />} />

        <Route element={<RequireAuth />}>
          <Route path="/welcome" element={<Welcome />} />
          <Route element={<RequireGroup />}>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="members" element={<Members />} />
              <Route path="members/:memberId" element={<MemberDetail />} />
              <Route path="deposits" element={<ComingSoon title="Deposits" />} />
              <Route path="loans" element={<ComingSoon title="Loans" />} />
              <Route path="withdrawals" element={<ComingSoon title="Withdrawals" />} />
              <Route path="transactions" element={<ComingSoon title="Transactions" />} />
              <Route path="reports" element={<ComingSoon title="Reports" />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
