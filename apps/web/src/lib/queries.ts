import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { api } from "./api";
import type { Group, Role } from "./types";

export type Member = { id: string; userId: string; name: string; email?: string; role: Role; status: string; joinedAt: string };

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

export function useMembers() {
  const { me } = useAuth();
  const groupId = me?.membership?.groupId;
  return useQuery({
    queryKey: ["members", groupId],
    enabled: !!groupId,
    queryFn: () => api<{ members: Member[] }>(`/api/groups/${groupId}/members`),
  });
}
