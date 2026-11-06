import { Prisma } from "@prisma/client";

// P2002 = "unique constraint failed" (includes our partial unique indexes).
export const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
