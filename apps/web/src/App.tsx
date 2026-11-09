import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import TestModeBanner from "./components/TestModeBanner";
import { RequireAuth, RequireGroup } from "./components/guards";
import { ComingSoon, NotFound } from "./pages/ComingSoon";
import Dashboard from "./pages/Dashboard";
import Welcome from "./pages/Welcome";
import AcceptInvitation from "./pages/auth/AcceptInvitation";
import ForgotPassword from "./pages/auth/ForgotPassword";
import Login from "./pages/auth/Login";
import Register from "./pages/auth/Register";
import ResetPassword from "./pages/auth/ResetPassword";
import VerifyEmail from "./pages/auth/VerifyEmail";

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
              <Route path="members" element={<ComingSoon title="Members" />} />
              <Route path="deposits" element={<ComingSoon title="Deposits" />} />
              <Route path="loans" element={<ComingSoon title="Loans" />} />
              <Route path="withdrawals" element={<ComingSoon title="Withdrawals" />} />
              <Route path="transactions" element={<ComingSoon title="Transactions" />} />
              <Route path="reports" element={<ComingSoon title="Reports" />} />
              <Route path="settings" element={<ComingSoon title="Settings" />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}
