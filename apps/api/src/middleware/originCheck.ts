import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { AppError } from "../lib/errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Browsers always send an Origin header on cross-site POSTs. If it isn't our
// frontend, refuse. (curl, server-to-server calls and webhooks send no Origin.)
export function originCheck(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get("origin");
  if (origin && origin !== env.WEB_ORIGIN) {
    throw new AppError(403, "BAD_ORIGIN", "Request origin not allowed.");
  }
  next();
}
