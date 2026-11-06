import argon2 from "argon2";

// argon2id is the recommended variant. In the library's typings this is the
// exact value 2; `as const` stops TypeScript from widening it to `number`.
const ARGON2ID = argon2.argon2id as 2;

const OPTIONS = {
  type: ARGON2ID,
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password, { ...OPTIONS, raw: false });

let dummyHash: Promise<string> | undefined;

// If the user doesn't exist we still do the same amount of work, so response
// time doesn't reveal which emails are registered.
export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword("not-a-real-password");
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
