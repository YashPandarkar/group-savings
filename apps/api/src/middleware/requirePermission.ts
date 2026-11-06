import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors";
import { can, type Permission } from "../lib/permissions";

// LAYER 3: does this member's ROLE allow this action?
// Must come AFTER requireAuth and requireGroupMember.
export const requirePermission =
  (permission: Permission) => (req: Request, _res: Response, next: NextFunction) => {
    if (!req.membership) {
      // A developer forgot requireGroupMember. Fail closed.
      throw new AppError(500, "MISCONFIGURED", "Route is missing membership check.");
    }
    if (!can(req.membership.role, permission)) {
      throw new AppError(403, "FORBIDDEN", "You don't have permission to do this.");
    }
    next();
  };
