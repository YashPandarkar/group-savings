export type Role = "PRESIDENT" | "VICE_PRESIDENT" | "MEMBER";

export type Me = {
  user: { id: string; email: string; name: string };
  membership: { groupId: string; groupName: string; role: Role } | null;
};

export const ROLE_LABEL: Record<Role, string> = {
  PRESIDENT: "President",
  VICE_PRESIDENT: "Vice President",
  MEMBER: "Member",
};

export const isAdmin = (role: Role | undefined): boolean => role === "PRESIDENT" || role === "VICE_PRESIDENT";
