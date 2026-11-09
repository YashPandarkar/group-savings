import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { FullPageSpinner } from "./ui";

// Everything inside needs a logged-in user. (The backend checks too: this is for a smooth experience.)
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <FullPageSpinner />;
  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

// Everything inside needs the user to belong to a group. Otherwise: create one or wait for an invitation.
export function RequireGroup() {
  const { me } = useAuth();
  if (!me?.membership) return <Navigate to="/welcome" replace />;
  return <Outlet />;
}
