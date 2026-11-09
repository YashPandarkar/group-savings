import type { ZodError } from "zod";
import { ApiError } from "./api";

export type FieldErrors = Record<string, string>;

export function zodErrors(error: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

// Turns the server's validation details into { fieldName: message }.
// `rename` maps server field names to form field names.
export function apiFieldErrors(e: unknown, rename: Record<string, string> = {}): FieldErrors {
  const out: FieldErrors = {};
  if (e instanceof ApiError) {
    for (const d of e.details) {
      const key = rename[d.field] ?? d.field;
      if (!(key in out)) out[key] = d.message;
    }
  }
  return out;
}
