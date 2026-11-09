// A fresh random id for idempotency keys and request ids (letters, digits and dashes only).
export const newId = (): string => crypto.randomUUID();
