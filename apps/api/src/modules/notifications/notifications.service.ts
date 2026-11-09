import type { Notification, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";

export type NotificationQuery = { page: number; pageSize: number; unread?: "true" | "false" };

const serialize = (n: Notification) => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  groupId: n.groupId,
  readAt: n.readAt,
  createdAt: n.createdAt,
});

export async function listNotifications(userId: string, q: NotificationQuery) {
  const where: Prisma.NotificationWhereInput = { userId, ...(q.unread === "true" ? { readAt: null } : {}) };
  const [total, unread, rows] = await prisma.$transaction([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  return { page: q.page, pageSize: q.pageSize, total, unread, items: rows.map(serialize) };
}

export const unreadCount = (userId: string) => prisma.notification.count({ where: { userId, readAt: null } });

// Marking something already read is harmless. Someone else's notification looks like it doesn't exist.
export async function markRead(userId: string, id: string) {
  const r = await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  if (r.count === 0) {
    const exists = await prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
    if (!exists) throw new AppError(404, "NOTIFICATION_NOT_FOUND", "Notification not found.");
  }
  return { unread: await unreadCount(userId) };
}

export async function markAllRead(userId: string) {
  const r = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return { updated: r.count };
}
