import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError } from "./api";
import { apiFieldErrors, zodErrors } from "./forms";

describe("zodErrors", () => {
  it("maps each field to its first message", () => {
    const schema = z.object({
      email: z.string().email("Enter a valid email"),
      password: z.string().min(5, "Too short").regex(/\d/, "Needs a digit"),
    });
    const result = schema.safeParse({ email: "x", password: "ab" });
    if (result.success) throw new Error("expected the input to be invalid");
    const errors = zodErrors(result.error);
    expect(errors.email).toBe("Enter a valid email");
    expect(errors.password).toBe("Too short");
  });
});

describe("apiFieldErrors", () => {
  it("renames server fields and keeps the first message per field", () => {
    const err = new ApiError(400, "VALIDATION_ERROR", "Please check the highlighted fields.", [
      { field: "amountPaise", message: "Too small" },
      { field: "amountPaise", message: "Second message" },
      { field: "other", message: "Bad" },
    ]);
    expect(apiFieldErrors(err, { amountPaise: "amount" })).toEqual({ amount: "Too small", other: "Bad" });
  });

  it("returns nothing for errors that aren't API validation errors", () => {
    expect(apiFieldErrors(new Error("boom"))).toEqual({});
  });
});
