import type { GroupRole, MembershipStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { can } from "../../lib/permissions";
import { lockGroup } from "../../lib/locks";
import { formatRupees } from "../../lib/money";
import { memberSavingsBalance } from "../../lib/ledgerAccounts";
import type { RequestMeta } from "../auth/auth.service";

type Tx = Prisma.TransactionClient;
const memberNotFound = () => new AppError(404, "MEMBER_NOT_FOUND", "Member not found.");

export async function listMembers(groupId: string, viewerRole: GroupRole) {
  const showEmail = can(viewerRole, "member:view_all");
  const rows = await prisma.groupMember.findMany({
    where: { groupId, status: "ACTIVE" },
    orderBy: { joinedAt: "asc" },
    include: { user: { select: { name: true, email: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.user.name,
    email: showEmail ? r.user.email : undefined,
    role: r.role,
    status: r.status,
    joinedAt: r.joinedAt,
  }));
}

export async function getMember(
  groupId: string,
  memberId: string,
  viewer: { id: string; role: GroupRole }
) {
  const isSelf = memberId === viewer.id;
  const privileged = can(viewer.role, "member:view_all");
  // Ordinary members may only open their own record.
  if (!isSelf && !privileged) throw memberNotFound();

  const m = await prisma.groupMember.findFirst({
    where: { id: memberId, groupId }, // groupId in the query = tenant isolation
    include: { user: { select: { name: true, email: true } } },
  });
  if (!m) throw memberNotFound();

  return {
    id: m.id,
    userId: m.userId,
    name: m.user.name,
    email: privileged || isSelf ? m.user.email : undefined,
    role: m.role,
    status: m.status,
    joinedAt: m.joinedAt,
    leftAt: m.leftAt,
    // Phase 6 adds contribution history here, Phase 8 adds loans.
  };
}

// ───────────── roles ─────────────

export async function changeRole(
  groupId: string,
  memberId: string,
  newRole: GroupRole,
  actor: { userId: string; membershipId: string },
  meta: RequestMeta
) {
  return prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);

    const target = await tx.groupMember.findFirst({
      where: { id: memberId, groupId, status: "ACTIVE" },
      include: { user: { select: { name: true } } },
    });
    if (!target) throw memberNotFound();

    if (target.userId === actor.userId) {
      throw new AppError(
        400,
        "CANNOT_CHANGE_OWN_ROLE",
        "You can't change your own role. To hand over the presidency, promote another member to President."
      );
    }
    if (target.role === newRole) {
      return { memberId: target.id, role: newRole, yourNewRole: "PRESIDENT" as GroupRole };
    }

    const previousRole = target.role;
    let demotedVicePresidents = 0;
    let yourNewRole: GroupRole = "PRESIDENT";

    if (newRole === "PRESIDENT") {
      // Transfer: demote the current President FIRST (only one allowed at a time).
      await tx.groupMember.update({ where: { id: actor.membershipId }, data: { role: "MEMBER" } });
      await tx.groupMember.update({ where: { id: target.id }, data: { role: "PRESIDENT" } });
      yourNewRole = "MEMBER";
    } else if (newRole === "VICE_PRESIDENT") {
      // Only one VP: the previous VP (if any) becomes an ordinary member.
      const demoted = await tx.groupMember.updateMany({
        where: { groupId, role: "VICE_PRESIDENT", status: "ACTIVE" },
        data: { role: "MEMBER" },
      });
      demotedVicePresidents = demoted.count;
      await tx.groupMember.update({ where: { id: target.id }, data: { role: "VICE_PRESIDENT" } });
    } else {
      await tx.groupMember.update({ where: { id: target.id }, data: { role: "MEMBER" } });
    }

    await audit(
      {
        actorId: actor.userId,
        groupId,
        action: newRole === "PRESIDENT" ? "PRESIDENCY_TRANSFERRED" : "MEMBER_ROLE_CHANGED",
        entityType: "GroupMember",
        entityId: target.id,
        before: { role: previousRole },
        after: { role: newRole, demotedVicePresidents },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
    await tx.notification.create({
      data: {
        userId: target.userId,
        groupId,
        type: "ROLE_CHANGED",
        title: "Your role changed",
        body: `You are now ${newRole.replace("_", " ").toLowerCase()} of the group.`,
      },
    });

    return { memberId: target.id, role: newRole, yourNewRole };
  });
}

// ───────────── leaving and removal ─────────────

// A member can only go once they owe nothing and the group owes them nothing.
async function assertSettled(tx: Tx, groupId: string, userId: string, subject: "you" | "this member") {
  const openLoan = await tx.loan.findFirst({
    where: { groupId, userId, status: { notIn: ["REJECTED", "COMPLETED"] } },
    select: { id: true },
  });
  if (openLoan) {
    throw new AppError(409, "HAS_OPEN_LOAN", `${cap(subject)} still ha${subject === "you" ? "ve" : "s"} a loan that isn't completed or rejected.`);
  }

  const overdue = await tx.contribution.findFirst({
    where: { groupId, userId, status: { in: ["PENDING", "PARTIAL"] }, dueDate: { lt: new Date() } },
    select: { id: true },
  });
  if (overdue) {
    throw new AppError(409, "HAS_DUES", `${cap(subject)} still ha${subject === "you" ? "ve" : "s"} unpaid monthly contributions.`);
  }

  const balance = await memberSavingsBalance(tx, groupId, userId);
  if (balance > 0n) {
    throw new AppError(
      409,
      "SAVINGS_NOT_PAID_OUT",
      `${cap(subject)} still ha${subject === "you" ? "ve" : "s"} ${formatRupees(balance)} in the group fund. The savings must be paid out first (withdrawals arrive in Phase 10).`
    );
  }
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

async function endMembership(
  tx: Tx,
  membershipId: string,
  status: Extract<MembershipStatus, "LEFT" | "REMOVED">
) {
  // The row is kept (history matters). It just stops being ACTIVE, which
  // also frees the user to join another group.
  await tx.groupMember.update({ where: { id: membershipId }, data: { status, leftAt: new Date() } });
}

export async function leaveGroup(
  groupId: string,
  membership: { id: string; role: GroupRole },
  userId: string,
  meta: RequestMeta
) {
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);

    const current = await tx.groupMember.findFirst({
      where: { id: membership.id, groupId, status: "ACTIVE" },
    });
    if (!current) throw memberNotFound();

    if (current.role === "PRESIDENT") {
      throw new AppError(
        409,
        "PRESIDENT_CANNOT_LEAVE",
        "Transfer the presidency to another member before leaving the group."
      );
    }
    await assertSettled(tx, groupId, userId, "you");
    await endMembership(tx, current.id, "LEFT");

    await audit(
      {
        actorId: userId,
        groupId,
        action: "MEMBER_LEFT",
        entityType: "GroupMember",
        entityId: current.id,
        before: { status: "ACTIVE", role: current.role },
        after: { status: "LEFT" },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
  });
}

export async function removeMember(
  groupId: string,
  memberId: string,
  actorUserId: string,
  meta: RequestMeta
) {
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);

    const target = await tx.groupMember.findFirst({ where: { id: memberId, groupId, status: "ACTIVE" } });
    if (!target) throw memberNotFound();
    if (target.userId === actorUserId) {
      throw new AppError(400, "CANNOT_REMOVE_SELF", "You can't remove yourself. Transfer the presidency, then leave.");
    }

    await assertSettled(tx, groupId, target.userId, "this member");
    await endMembership(tx, target.id, "REMOVED");

    await audit(
      {
        actorId: actorUserId,
        groupId,
        action: "MEMBER_REMOVED",
        entityType: "GroupMember",
        entityId: target.id,
        before: { status: "ACTIVE", role: target.role },
        after: { status: "REMOVED" },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
    await tx.notification.create({
      data: {
        userId: target.userId,
        groupId,
        type: "MEMBER_REMOVED",
        title: "You were removed from the group",
        body: "The President removed you from the group.",
      },
    });
  });
}
