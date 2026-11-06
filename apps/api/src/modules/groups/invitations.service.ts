import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { sendEmail } from "../../lib/mailer";
import { newOpaqueToken, sha256 } from "../../lib/tokens";
import { ensureMemberAccounts } from "../../lib/ledgerAccounts";
import { lockGroup } from "../../lib/locks";
import { isUniqueViolation } from "../../lib/dbErrors";
import type { RequestMeta } from "../auth/auth.service";

const DAY = 24 * 60 * 60 * 1000;
const INVITE_TTL_DAYS = 7;

const invalidInvitation = () =>
  new AppError(400, "INVALID_INVITATION", "This invitation is invalid or has expired.");

// ───────────── president side ─────────────

export async function createInvitation(
  groupId: string,
  actor: { id: string; name: string },
  email: string,
  meta: RequestMeta
) {
  const rawToken = newOpaqueToken();

  const { invitation, groupName } = await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId); // so two invitations can't both take the last seat

    const group = await tx.group.findUniqueOrThrow({
      where: { id: groupId },
      select: { name: true, maxMembers: true },
    });

    // We only reveal facts about THIS group. We never say whether the person
    // belongs to some other group: acceptance enforces that rule privately.
    const invitee = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (invitee) {
      const already = await tx.groupMember.findFirst({
        where: { groupId, userId: invitee.id, status: "ACTIVE" },
        select: { id: true },
      });
      if (already) throw new AppError(409, "ALREADY_MEMBER", "This person is already a member of your group.");
    }

    const now = new Date();
    const active = await tx.groupMember.count({ where: { groupId, status: "ACTIVE" } });
    const pending = await tx.invitation.count({
      where: { groupId, status: "PENDING", expiresAt: { gt: now }, email: { not: email } },
    });
    if (active + pending >= group.maxMembers) {
      throw new AppError(409, "GROUP_FULL", "The group has no free seats (members plus pending invitations).");
    }

    // Re-inviting the same email replaces the old link.
    await tx.invitation.updateMany({
      where: { groupId, email, status: "PENDING" },
      data: { status: "CANCELLED" },
    });

    const created = await tx.invitation.create({
      data: {
        groupId,
        email,
        tokenHash: sha256(rawToken), // only the hash is stored
        invitedById: actor.id,
        expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * DAY),
      },
    });

    await audit(
      {
        actorId: actor.id,
        groupId,
        action: "INVITATION_CREATED",
        entityType: "Invitation",
        entityId: created.id,
        after: { email },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
    return { invitation: created, groupName: group.name };
  });

  await sendEmail({
    to: email,
    subject: `${actor.name} invited you to join "${groupName}"`,
    text:
      `Hello,\n\n${actor.name} invited you to join the savings group "${groupName}".\n\n` +
      `Accept the invitation: ${env.WEB_ORIGIN}/accept-invitation?token=${rawToken}\n\n` +
      `Log in (or register) with THIS email address (${email}). ` +
      `The link expires in ${INVITE_TTL_DAYS} days. If you weren't expecting this, ignore it.`,
  });

  return {
    id: invitation.id,
    email: invitation.email,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  };
}

export async function listInvitations(groupId: string) {
  const rows = await prisma.invitation.findMany({
    where: { groupId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { invitedBy: { select: { name: true } } },
  });
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    // "EXPIRED" is computed from the clock, so no cleanup job is required.
    status: r.status === "PENDING" && r.expiresAt < now ? "EXPIRED" : r.status,
    invitedBy: r.invitedBy.name,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  }));
}

export async function cancelInvitation(
  groupId: string,
  invitationId: string,
  actorId: string,
  meta: RequestMeta
) {
  const result = await prisma.invitation.updateMany({
    where: { id: invitationId, groupId, status: "PENDING" }, // groupId = tenant isolation
    data: { status: "CANCELLED" },
  });
  if (result.count !== 1) throw new AppError(404, "NOT_FOUND", "Pending invitation not found.");

  await audit({
    actorId,
    groupId,
    action: "INVITATION_CANCELLED",
    entityType: "Invitation",
    entityId: invitationId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

// ───────────── invitee side ─────────────

// Lets the invitation page show "Join Mitra Savings Circle?" before login.
export async function previewInvitation(rawToken: string) {
  const inv = await prisma.invitation.findUnique({
    where: { tokenHash: sha256(rawToken) },
    include: { group: { select: { name: true } }, invitedBy: { select: { name: true } } },
  });
  if (!inv || inv.status !== "PENDING" || inv.expiresAt < new Date()) throw invalidInvitation();
  return {
    groupName: inv.group.name,
    invitedBy: inv.invitedBy.name,
    invitedEmail: inv.email,
    expiresAt: inv.expiresAt,
  };
}

export async function acceptInvitation(
  user: { id: string },
  rawToken: string,
  meta: RequestMeta
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const inv = await tx.invitation.findUnique({ where: { tokenHash: sha256(rawToken) } });
      if (!inv || inv.status !== "PENDING" || inv.expiresAt < new Date()) throw invalidInvitation();

      const me = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (!me.emailVerifiedAt || me.email !== inv.email) {
        throw new AppError(
          403,
          "WRONG_ACCOUNT",
          "This invitation was sent to a different email address. Log in with the invited account."
        );
      }

      await lockGroup(tx, inv.groupId);

      const existing = await tx.groupMember.findFirst({
        where: { userId: me.id, status: "ACTIVE" },
        select: { id: true },
      });
      if (existing) {
        throw new AppError(409, "ALREADY_IN_GROUP", "You already belong to a group. Leave it before joining another.");
      }

      const group = await tx.group.findUniqueOrThrow({
        where: { id: inv.groupId },
        select: { id: true, name: true, maxMembers: true },
      });
      const active = await tx.groupMember.count({ where: { groupId: group.id, status: "ACTIVE" } });
      if (active >= group.maxMembers) {
        throw new AppError(409, "GROUP_FULL", "This group is full.");
      }

      // Atomic claim: if two requests race, only one gets count === 1.
      const claimed = await tx.invitation.updateMany({
        where: { id: inv.id, status: "PENDING" },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });
      if (claimed.count !== 1) throw invalidInvitation();

      const membership = await tx.groupMember.create({
        data: { groupId: group.id, userId: me.id, role: "MEMBER" }, // always joins as MEMBER
      });
      await ensureMemberAccounts(tx, group.id, me.id);

      // One group at a time, so invitations from other groups are cancelled.
      await tx.invitation.updateMany({
        where: { email: me.email, status: "PENDING", id: { not: inv.id } },
        data: { status: "CANCELLED" },
      });

      await tx.notification.create({
        data: {
          userId: inv.invitedById,
          groupId: group.id,
          type: "MEMBER_JOINED",
          title: "New member joined",
          body: `${me.name} accepted your invitation.`,
        },
      });
      await audit(
        {
          actorId: me.id,
          groupId: group.id,
          action: "INVITATION_ACCEPTED",
          entityType: "Invitation",
          entityId: inv.id,
          after: { membershipId: membership.id },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx
      );

      return { groupId: group.id, groupName: group.name, role: membership.role };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // The database's one-active-group-per-user index caught a parallel request.
      throw new AppError(409, "ALREADY_IN_GROUP", "You already belong to a group. Leave it before joining another.");
    }
    throw e;
  }
}
