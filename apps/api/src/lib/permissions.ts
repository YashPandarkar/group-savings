import type { GroupRole } from "@prisma/client";

// A permission is a KIND of action. Whether a member may touch a specific record
// (e.g. only THEIR OWN loan) is checked separately in the services.

const MEMBER_PERMS = [
  "group:view",
  "balance:view",
  "transactions:view_group",
  "contribution:view_own",
  "deposit:create",
  "loan:apply",
  "loan:view_own",
  "loan:repay",
  "notification:view",
] as const;

const VICE_PRESIDENT_EXTRA = [
  "contribution:view_all",
  "member:view_all",
  "deposit:record_manual",
  "loan:review",
  "loan:view_all",
  "withdrawal:request",
  "withdrawal:approve",
  "withdrawal:view",
  "report:view",
  "audit:view",
] as const;

const PRESIDENT_EXTRA = [
  "loan:approve",
  "loan:reject",
  "loan:disburse",
  "group:manage_rules",
  "group:update_settings",
  "invitation:manage",
  "member:change_role",
  "member:remove",
] as const;

export type Permission =
  | (typeof MEMBER_PERMS)[number]
  | (typeof VICE_PRESIDENT_EXTRA)[number]
  | (typeof PRESIDENT_EXTRA)[number];

const ROLE_PERMISSIONS: Record<GroupRole, ReadonlySet<Permission>> = {
  MEMBER: new Set<Permission>(MEMBER_PERMS),
  VICE_PRESIDENT: new Set<Permission>([...MEMBER_PERMS, ...VICE_PRESIDENT_EXTRA]),
  PRESIDENT: new Set<Permission>([...MEMBER_PERMS, ...VICE_PRESIDENT_EXTRA, ...PRESIDENT_EXTRA]),
};

export const ALL_PERMISSIONS: Permission[] = [
  ...MEMBER_PERMS,
  ...VICE_PRESIDENT_EXTRA,
  ...PRESIDENT_EXTRA,
];

export const can = (role: GroupRole, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role].has(permission);
