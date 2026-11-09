import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { AppError } from "../lib/errors";

export async function requireWithdrawalAccess(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new AppError(401, "UNAUTHENTICATED", "Please log in.");

  const w = await prisma.withdrawal.findUnique({
    where: { id: String(req.params.withdrawalId) },
    select: { groupId: true },
  });
  const membership = w
    ? await prisma.groupMember.findFirst({
        where: { groupId: w.groupId, userId: req.user.id, status: "ACTIVE" },
        select: { id: true, groupId: true, role: true },
      })
    : null;
  if (!membership) throw new AppError(404, "WITHDRAWAL_NOT_FOUND", "Withdrawal not found.");

  req.membership = membership;
  next();
}
