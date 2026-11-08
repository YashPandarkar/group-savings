import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";
import { AppError } from "../lib/errors";

// Rejects bad input BEFORE it reaches any business logic.
export const validateBody =
  (schema: z.ZodType) => (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Please check the highlighted fields.",
        result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
      );
    }
    req.body = result.data; // cleaned values (trimmed, lowercased...)
    next();
  };

// Express 5 makes req.query read-only, so the cleaned result goes in res.locals.query.
export const validateQuery =
  (schema: z.ZodType) => (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Please check the query parameters.",
        result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
      );
    }
    res.locals.query = result.data;
    next();
  };
