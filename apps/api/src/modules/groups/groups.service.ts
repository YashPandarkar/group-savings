import type { Group, GroupRole, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { decryptField, encryptField } from "../../lib/crypto";
import { paiseToNumber } from "../../lib/money";
import { ensureGroupAccounts, ensureMemberAccounts } from "../../lib/ledgerAccounts";
import { lockGroup } from "../../lib/locks";
import { isUniqueViolation } from "../../lib/dbErrors";
import type { RequestMeta } from "../auth/auth.service";
import type { CreateGroupInput, UpdateGroupInput } from "./groups.schema";

const alreadyInGroup = () =>
  new AppError(409, "ALREADY_IN_GROUP", "You already belong to a group. Leave it before joining or creating another.");

function assertInterestPolicy(method: string, bps: number) {
  if (method === "NONE" && bps !== 0) {
    throw new AppError(400, "VALIDATION_ERROR", "A no-interest group must have a 0% rate.");
  }
  if (method !== "NONE" && bps === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "Choose a rate above 0%, or set the policy to No interest.");
  }
}

// What the API returns. Money is converted from BigInt to a plain number of paise.
export function serializeGroup(g: Group, yourRole: GroupRole) {
  let accountNumber: string | null = null;
  if (g.bankAccountNumberEnc) {
    try {
      accountNumber = decryptField(g.bankAccountNumberEnc);
    } catch {
      accountNumber = null; // wrong key or corrupted value: never crash the page
    }
  }
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    logoUrl: g.logoUrl,
    monthlyContributionPaise: paiseToNumber(g.monthlyContributionPaise),
    maxMembers: g.maxMembers,
    contributionDueDay: g.contributionDueDay,
    rules: g.rules,
    interestMethod: g.interestMethod,
    interestRateBps: g.interestRateBps,
    defaultRepaymentMonths: g.defaultRepaymentMonths,
    allowPartialRepayment: g.allowPartialRepayment,
    allowEarlyRepayment: g.allowEarlyRepayment,
    requireDualApproval: g.requireDualApproval,
    // Where members send money. The app never holds these funds.
    payment: {
      accountHolder: g.bankAccountHolder,
      accountNumber,
      ifsc: g.bankIfsc,
      upiId: g.upiId,
    },
    createdAt: g.createdAt,
    yourRole,
  };
}

// Plain, JSON-safe snapshot for the audit log. The account number is never logged.
function auditView(g: Group) {
  return {
    name: g.name,
    description: g.description,
    logoUrl: g.logoUrl,
    monthlyContributionPaise: paiseToNumber(g.monthlyContributionPaise),
    maxMembers: g.maxMembers,
    contributionDueDay: g.contributionDueDay,
    rules: g.rules,
    interestMethod: g.interestMethod,
    interestRateBps: g.interestRateBps,
    defaultRepaymentMonths: g.defaultRepaymentMonths,
    allowPartialRepayment: g.allowPartialRepayment,
    allowEarlyRepayment: g.allowEarlyRepayment,
    requireDualApproval: g.requireDualApproval,
    bankAccountHolder: g.bankAccountHolder,
    bankIfsc: g.bankIfsc,
    upiId: g.upiId,
    bankAccountNumberSet: g.bankAccountNumberEnc !== null,
  };
}

export async function createGroup(
  user: { id: string; email: string },
  input: CreateGroupInput,
  meta: RequestMeta
) {
  assertInterestPolicy(input.interestMethod, input.interestRateBps);

  try {
    const group = await prisma.$transaction(async (tx) => {
      // Friendly check. The database index from Phase 3 is the real guarantee.
      const existing = await tx.groupMember.findFirst({
        where: { userId: user.id, status: "ACTIVE" },
        select: { id: true },
      });
      if (existing) throw alreadyInGroup();

      const created = await tx.group.create({
        data: {
          name: input.name,
          description: input.description || null,
          logoUrl: input.logoUrl ?? null,
          monthlyContributionPaise: BigInt(input.monthlyContributionPaise),
          maxMembers: input.maxMembers,
          contributionDueDay: input.contributionDueDay,
          rules: input.rules || null,
          interestMethod: input.interestMethod,
          interestRateBps: input.interestRateBps,
          defaultRepaymentMonths: input.defaultRepaymentMonths,
          allowPartialRepayment: input.allowPartialRepayment,
          allowEarlyRepayment: input.allowEarlyRepayment,
          requireDualApproval: input.requireDualApproval,
          bankAccountHolder: input.bankAccountHolder ?? null,
          bankAccountNumberEnc: input.bankAccountNumber ? encryptField(input.bankAccountNumber) : null,
          bankIfsc: input.bankIfsc ?? null,
          upiId: input.upiId ?? null,
          createdById: user.id,
        },
      });

      await tx.groupMember.create({ data: { groupId: created.id, userId: user.id, role: "PRESIDENT" } });
      await ensureGroupAccounts(tx, created.id);
      await ensureMemberAccounts(tx, created.id, user.id);

      // They're in a group now, so their other pending invitations are moot.
      await tx.invitation.updateMany({
        where: { email: user.email, status: "PENDING" },
        data: { status: "CANCELLED" },
      });

      await audit(
        {
          actorId: user.id,
          groupId: created.id,
          action: "GROUP_CREATED",
          entityType: "Group",
          entityId: created.id,
          after: auditView(created),
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx
      );
      return created;
    });

    return serializeGroup(group, "PRESIDENT");
  } catch (e) {
    if (isUniqueViolation(e)) throw alreadyInGroup(); // lost a race with a parallel request
    throw e;
  }
}

export async function getMyGroup(userId: string) {
  const m = await prisma.groupMember.findFirst({
    where: { userId, status: "ACTIVE" },
    include: { group: true },
  });
  return m ? serializeGroup(m.group, m.role) : null;
}

export async function getGroup(groupId: string, role: GroupRole) {
  const group = await prisma.group.findUniqueOrThrow({ where: { id: groupId } });
  const memberCount = await prisma.groupMember.count({ where: { groupId, status: "ACTIVE" } });
  return { ...serializeGroup(group, role), memberCount };
}

export async function updateGroup(
  groupId: string,
  actorId: string,
  role: GroupRole,
  input: UpdateGroupInput,
  meta: RequestMeta
) {
  const updated = await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const before = await tx.group.findUniqueOrThrow({ where: { id: groupId } });

    assertInterestPolicy(
      input.interestMethod ?? before.interestMethod,
      input.interestRateBps ?? before.interestRateBps
    );

    if (input.maxMembers !== undefined) {
      const active = await tx.groupMember.count({ where: { groupId, status: "ACTIVE" } });
      if (input.maxMembers < active) {
        throw new AppError(
          409,
          "CAPACITY_BELOW_MEMBERS",
          `The group already has ${active} members, so the limit can't be lower than that.`
        );
      }
    }

    const { description, rules, bankAccountNumber, monthlyContributionPaise, ...plain } = input;
    const data: Prisma.GroupUpdateInput = { ...plain };
    if (description !== undefined) data.description = description || null;
    if (rules !== undefined) data.rules = rules || null;
    if (bankAccountNumber !== undefined) data.bankAccountNumberEnc = encryptField(bankAccountNumber);
    if (monthlyContributionPaise !== undefined) {
      data.monthlyContributionPaise = BigInt(monthlyContributionPaise);
    }

    const after = await tx.group.update({ where: { id: groupId }, data });

    await audit(
      {
        actorId,
        groupId,
        action: "GROUP_SETTINGS_UPDATED",
        entityType: "Group",
        entityId: groupId,
        before: auditView(before),
        after: auditView(after),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
    return after;
  });

  return serializeGroup(updated, role);
}
