import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { AppError } from "../lib/errors";

// LAYER 2 (tenant isolation): is this user an ACTIVE member of THIS group?
// Use on every route shaped like /groups/:groupId/...
export async function requireGroupMember(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new AppError(401, "UNAUTHENTICATED", "Please log in.");

  const groupId = String(req.params.groupId);
  const membership = await prisma.groupMember.findFirst({
    where: { groupId, userId: req.user.id, status: "ACTIVE" },
    select: { id: true, groupId: true, role: true },
  });

  // 404, not 403: don't reveal whether the group exists.
  if (!membership) throw new AppError(404, "NOT_FOUND", "Group not found.");

  req.membership = membership;
  next();
}
