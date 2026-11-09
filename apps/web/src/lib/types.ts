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

export type InterestMethod = "NONE" | "FLAT" | "REDUCING_BALANCE";

export const INTEREST_LABEL: Record<InterestMethod, string> = {
  NONE: "No interest",
  FLAT: "Flat interest",
  REDUCING_BALANCE: "Reducing balance",
};

export type Group = {
  id: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  monthlyContributionPaise: number;
  maxMembers: number;
  contributionDueDay: number;
  rules: string | null;
  interestMethod: InterestMethod;
  interestRateBps: number;
  defaultRepaymentMonths: number;
  allowPartialRepayment: boolean;
  allowEarlyRepayment: boolean;
  requireDualApproval: boolean;
  payment: { accountHolder: string | null; accountNumber: string | null; ifsc: string | null; upiId: string | null };
  createdAt: string;
  yourRole: Role;
  memberCount?: number;
};
