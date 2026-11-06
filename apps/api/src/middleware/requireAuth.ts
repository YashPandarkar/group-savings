import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma";
import { AppError } from "../lib/errors";
import { verifyAccessToken } from "../lib/jwt";

// LAYER 1: who is calling? Reads the Bearer token and loads the user.
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AppError(401, "UNAUTHENTICATED", "Please log in.");
  }
  const userId = verifyAccessToken(header.slice(7));

  // Checked on every request, so deactivating a user takes effect immediately.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, isActive: true },
  });
  if (!user || !user.isActive) {
    throw new AppError(401, "UNAUTHENTICATED", "Please log in.");
  }
  req.user = { id: user.id, email: user.email, name: user.name };
  next();
}
