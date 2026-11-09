import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { api } from "./api";

export type FundReport = {
  basis: string;
  fundBalancePaise: number;
  memberBalances: { userId: string; name: string; active: boolean; savingsPaise: number }[];
  byType: { type: string; count: number; totalPaise: number }[];
};

// Shared by the Reports page, the Dashboard and the withdrawal form (same cache key). Administrators only.
export function useFundReport(enabled: boolean) {
  const { me } = useAuth();
  const groupId = me?.membership?.groupId;
  return useQuery({
    queryKey: ["fund-report", groupId],
    enabled: enabled && !!groupId,
    queryFn: () => api<FundReport>(`/api/groups/${groupId}/reports/fund`),
  });
}
