import { PrismaClient } from "@prisma/client";
import { env } from "./env";

// One shared client for the whole app (it manages its own connection pool).
export const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL } },
});
