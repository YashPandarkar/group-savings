import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../config/prisma";

type Db = PrismaClient | Prisma.TransactionClient;

export type AuditEntry = {
  actorId?: string | null;
  groupId?: string | null;
  action: string; // e.g. USER_LOGIN
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
};

export async function audit(entry: AuditEntry, db: Db = prisma): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      groupId: entry.groupId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before,
      after: entry.after,
      ipAddress: entry.ip,
      userAgent: entry.userAgent?.slice(0, 300),
    },
  });
}
