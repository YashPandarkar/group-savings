import { randomUUID } from "node:crypto";
import { Prisma, type EmailTokenPurpose } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { hashPassword, verifyPassword } from "../../lib/password";
import { newOpaqueToken, sha256 } from "../../lib/tokens";
import { signAccessToken } from "../../lib/jwt";
import { sendEmail } from "../../lib/mailer";
import { audit } from "../../lib/audit";

export type RequestMeta = { ip?: string; userAgent?: string };
type Db = Prisma.TransactionClient | typeof prisma;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const unauthorized = () => new AppError(401, "UNAUTHENTICATED", "Please log in.");
const invalidToken = () =>
  new AppError(400, "INVALID_TOKEN", "This link is invalid or has expired.");

// ───────────── email tokens (verify + reset) ─────────────

async function createEmailToken(userId: string, purpose: EmailTokenPurpose, ttlMs: number) {
  // Only the newest link works: invalidate older unused ones.
  await prisma.emailToken.updateMany({
    where: { userId, purpose, usedAt: null },
    data: { usedAt: new Date() },
  });
  const raw = newOpaqueToken();
  await prisma.emailToken.create({
    data: { userId, purpose, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + ttlMs) },
  });
  return raw;
}

async function consumeEmailToken(rawToken: string, purpose: EmailTokenPurpose, tx: Db) {
  const record = await tx.emailToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt < new Date()) {
    throw invalidToken();
  }
  // Atomic "claim": if two requests race, only one gets count === 1.
  const claimed = await tx.emailToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) throw invalidToken();
  return record.userId;
}

async function sendVerificationEmail(user: { id: string; name: string; email: string }) {
  const token = await createEmailToken(user.id, "VERIFY_EMAIL", 24 * HOUR);
  await sendEmail({
    to: user.email,
    subject: "Verify your email",
    text: `Hello ${user.name},\n\nVerify your email: ${env.WEB_ORIGIN}/verify-email?token=${token}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`,
  });
}

// ───────────── register / verify ─────────────

export async function register(
  input: { name: string; email: string; password: string },
  meta: RequestMeta
): Promise<void> {
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await prisma.user.create({
      data: { name: input.name, email: input.email, passwordHash },
    });
    await sendVerificationEmail(user);
    await audit({ actorId: user.id, action: "USER_REGISTERED", entityType: "User", entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  } catch (e) {
    // Email already registered: do nothing and respond exactly as if it worked,
    // so attackers can't discover who has an account.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return;
    throw e;
  }
}

export async function verifyEmail(rawToken: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const userId = await consumeEmailToken(rawToken, "VERIFY_EMAIL", tx);
    await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  });
}

export async function resendVerification(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.isActive && !user.emailVerifiedAt) await sendVerificationEmail(user);
}

// ───────────── sessions ─────────────

async function createRefreshToken(db: Db, userId: string, familyId: string, meta: RequestMeta) {
  const raw = newOpaqueToken();
  const row = await db.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY),
      ipAddress: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300),
    },
  });
  return { raw, id: row.id };
}

export async function login(email: string, password: string, meta: RequestMeta) {
  const user = await prisma.user.findUnique({ where: { email } });
  const passwordOk = await verifyPassword(user?.passwordHash ?? null, password);

  // Same answer for "no such user", "wrong password" and "deactivated".
  if (!user || !passwordOk || !user.isActive) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");
  }
  if (!user.emailVerifiedAt) {
    throw new AppError(403, "EMAIL_NOT_VERIFIED", "Please verify your email before logging in.");
  }

  const refresh = await createRefreshToken(prisma, user.id, randomUUID(), meta);
  await audit({ actorId: user.id, action: "USER_LOGIN", entityType: "User", entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });

  return {
    accessToken: signAccessToken(user.id),
    refreshToken: refresh.raw,
    user: { id: user.id, email: user.email, name: user.name },
  };
}

export async function refresh(rawToken: string | undefined, meta: RequestMeta) {
  if (!rawToken) throw unauthorized();

  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(rawToken) },
    include: { user: true },
  });
  if (!record) throw unauthorized();

  // A token that was already used/revoked is being replayed: likely stolen.
  // Kill the entire family so the thief AND the victim must log in again.
  if (record.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: record.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({ actorId: record.userId, action: "REFRESH_TOKEN_REUSE_DETECTED", entityType: "User", entityId: record.userId, ip: meta.ip, userAgent: meta.userAgent });
    throw unauthorized();
  }
  if (record.expiresAt < new Date() || !record.user.isActive) throw unauthorized();

  // Rotate: revoke the old token and issue a new one, atomically.
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) throw unauthorized();

    const next = await createRefreshToken(tx, record.userId, record.familyId, meta);
    await tx.refreshToken.update({ where: { id: record.id }, data: { replacedById: next.id } });
    return { accessToken: signAccessToken(record.userId), refreshToken: next.raw };
  });
}

export async function logout(rawToken: string | undefined, meta: RequestMeta): Promise<void> {
  if (!rawToken) return;
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
  if (!record) return;
  await prisma.refreshToken.updateMany({
    where: { familyId: record.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await audit({ actorId: record.userId, action: "USER_LOGOUT", entityType: "User", entityId: record.userId, ip: meta.ip, userAgent: meta.userAgent });
}

// ───────────── password reset ─────────────

export async function forgotPassword(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive) return; // respond identically either way

  const token = await createEmailToken(user.id, "RESET_PASSWORD", 1 * HOUR);
  await sendEmail({
    to: user.email,
    subject: "Reset your password",
    text: `Hello ${user.name},\n\nReset your password: ${env.WEB_ORIGIN}/reset-password?token=${token}\n\nThis link expires in 1 hour. If you didn't ask for this, ignore this email.`,
  });
}

export async function resetPassword(rawToken: string, newPassword: string, meta: RequestMeta): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  const userId = await prisma.$transaction(async (tx) => {
    const id = await consumeEmailToken(rawToken, "RESET_PASSWORD", tx);
    await tx.user.update({ where: { id }, data: { passwordHash } });
    // Log out everywhere: all existing sessions die.
    await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    return id;
  });
  await audit({ actorId: userId, action: "PASSWORD_RESET", entityType: "User", entityId: userId, ip: meta.ip, userAgent: meta.userAgent });
}

// ───────────── who am I ─────────────

export async function getMe(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true, emailVerifiedAt: true, createdAt: true },
  });
  // One user = at most one active group (database-enforced since Phase 3).
  const m = await prisma.groupMember.findFirst({
    where: { userId, status: "ACTIVE" },
    select: { role: true, group: { select: { id: true, name: true } } },
  });
  return {
    user,
    membership: m ? { groupId: m.group.id, groupName: m.group.name, role: m.role } : null,
  };
}
