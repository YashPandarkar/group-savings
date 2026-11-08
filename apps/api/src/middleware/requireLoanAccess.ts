import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { AppError } from "../lib/errors";

export async function requireLoanAccess(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw new AppError(401, "UNAUTHENTICATED", "Please log in.");

  const loan = await prisma.loan.findUnique({
    where: { id: String(req.params.loanId) },
    select: { groupId: true },
  });
  const membership = loan
    ? await prisma.groupMember.findFirst({
        where: { groupId: loan.groupId, userId: req.user.id, status: "ACTIVE" },
        select: { id: true, groupId: true, role: true },
      })
    : null;
  if (!membership) throw new AppError(404, "LOAN_NOT_FOUND", "Loan not found.");

  req.membership = membership;
  next();
}