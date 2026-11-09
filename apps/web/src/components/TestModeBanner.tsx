import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

type Health = { paymentMode: "sandbox" | "live"; paymentProvider?: string };

// Always visible unless the server is in live mode: nobody should mistake test money for real money.
export default function TestModeBanner() {
  const { data } = useQuery({
    queryKey: ["health"],
    queryFn: () => api<Health>("/api/health", { auth: false }),
    staleTime: 5 * 60_000,
  });
  if (!data || data.paymentMode === "live") return null;
  return (
    <div className="bg-amber-400 px-4 py-2 text-center text-sm font-semibold text-amber-950">
      TEST MODE: no real money is moved{data.paymentProvider === "simulator" ? " (payment simulator)" : ""}
    </div>
  );
}
