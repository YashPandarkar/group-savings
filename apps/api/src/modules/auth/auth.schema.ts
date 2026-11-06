import { z } from "zod";

const email = z.string().trim().toLowerCase().email("Enter a valid email").max(254);

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password is too long")
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/[0-9]/, "Password must contain a number");

const token = z.string().min(20).max(200);

export const registerSchema = z.object({
  name: z.string().trim().min(2, "Enter your name").max(80),
  email,
  password: passwordSchema,
});
export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const emailOnlySchema = z.object({ email });
export const tokenOnlySchema = z.object({ token });
export const resetPasswordSchema = z.object({ token, password: passwordSchema });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type EmailOnlyInput = z.infer<typeof emailOnlySchema>;
export type TokenOnlyInput = z.infer<typeof tokenOnlySchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
