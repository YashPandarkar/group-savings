import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { AppError } from "./errors";

export function signAccessToken(userId: string): string {
  return jwt.sign({}, env.JWT_ACCESS_SECRET, {
    subject: userId,
    algorithm: "HS256",
    expiresIn: env.ACCESS_TOKEN_TTL_MIN * 60, // seconds
  });
}

// Returns the user id, or throws a 401.
export function verifyAccessToken(token: string): string {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      throw new Error("malformed");
    }
    return payload.sub;
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) {
      throw new AppError(401, "TOKEN_EXPIRED", "Session expired. Please refresh.");
    }
    throw new AppError(401, "UNAUTHENTICATED", "Please log in.");
  }
}
