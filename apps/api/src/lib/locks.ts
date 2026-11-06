import type { Prisma } from "@prisma/client";

// Locks the group's row until the surrounding transaction ends. Any other
// transaction that tries to lock the same group WAITS, so "check then change"
// sequences (capacity, role transfer, balance checks) can't interleave.
export async function lockGroup(tx: Prisma.TransactionClient, groupId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${groupId} FOR UPDATE`;
}
