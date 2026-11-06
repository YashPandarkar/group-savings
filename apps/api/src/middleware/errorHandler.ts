import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors";

const errType = (e: unknown) =>
  typeof e === "object" && e !== null && "type" in e ? String((e as { type: unknown }).type) : "";

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (errType(err) === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON." } });
  }
  if (errType(err) === "entity.too.large") {
    return res.status(413).json({ error: { code: "TOO_LARGE", message: "Request body is too large." } });
  }
  console.error(err); // full detail stays in OUR logs only
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong." } });
}
