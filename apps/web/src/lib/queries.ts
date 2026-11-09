import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { api } from "./api";
import type { Group } from "./types";

// The current user's group (settings, payment details, member count). Cached and shared across pages.
export function useGroup() {
  const { me } = useAuth();
  const groupId = me?.membership?.groupId;
  return useQuery({
    queryKey: ["group", groupId],
    enabled: !!groupId,
    queryFn: async () => (await api<{ group: Group }>(`/api/groups/${groupId}`)).group,
  });
}
