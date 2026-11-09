import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { hashPassword, verifyPassword } from "../../lib/password";
import { sha256 } from "../../lib/tokens";
import type { RequestMeta } from "../auth/auth.service";

export async function updateProfile(userId: string, name: string, meta: RequestMeta) {
  const before = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
  const user = await prisma.user.update({
    where: { id: userId },
    data: { name },
    select: { id: true, email: true, name: true },
  });
  await audit({
    actorId: userId,
    action: "PROFILE_UPDATED",
    entityType: "User",
    entityId: userId,
    before: { name: before.name },
    after: { name },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return user;
}

// Verifies the current password, sets the new one, and logs out every OTHER session.
// The caller's own session (identified by the refresh cookie) keeps working.
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  currentRefreshToken: string | undefined,
  meta: RequestMeta
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    // 400, not 401: a 401 would make the frontend think the session expired.
    throw new AppError(400, "INVALID_CURRENT_PASSWORD", "Your current password is incorrect.");
  }
  if (currentPassword === newPassword) {
    throw new AppError(400, "PASSWORD_UNCHANGED", "Choose a password different from your current one.");
  }
  const passwordHash = await hashPassword(newPassword);

  let keepFamily: string | undefined;
  if (currentRefreshToken) {
    const record = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(currentRefreshToken) } });
    if (record && record.userId === userId && !record.revokedAt) keepFamily = record.familyId;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null, ...(keepFamily ? { familyId: { not: keepFamily } } : {}) },
      data: { revokedAt: new Date() },
    });
    await audit(
      {
        actorId: userId,
        action: "PASSWORD_CHANGED",
        entityType: "User",
        entityId: userId,
        after: { otherSessionsRevoked: true },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
  });
}
