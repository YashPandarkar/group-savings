import { z } from "zod";
import { passwordSchema } from "../auth/auth.schema";

// Unknown fields (email, role, isActive...) are silently dropped by zod: a profile call can never change them.
export const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter your name").max(80),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(128),
  newPassword: passwordSchema,
});

export type ProfileInput = z.infer<typeof profileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
