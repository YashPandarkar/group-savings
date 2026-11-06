import { Router, type CookieOptions, type Request, type Response } from "express";
import { env } from "../../config/env";
import { validateBody } from "../../middleware/validate";
import { requireAuth } from "../../middleware/requireAuth";
import { authLimiter, loginLimiter } from "../../middleware/rateLimit";
import * as service from "./auth.service";
import {
  emailOnlySchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  tokenOnlySchema,
  type EmailOnlyInput,
  type LoginInput,
  type RegisterInput,
  type ResetPasswordInput,
  type TokenOnlyInput,
} from "./auth.schema";

const router = Router();

const REFRESH_COOKIE = "rt";

// HttpOnly: JavaScript can't read it. Strict: never sent on cross-site requests.
// Path: only sent to /api/auth/*, not to every API call.
const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/api/auth",
};

const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    ...cookieOptions,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

router.post("/register", authLimiter, validateBody(registerSchema), async (req, res) => {
  await service.register(req.body as RegisterInput, meta(req));
  res.status(202).json({ message: "Check your email for a verification link." });
});

router.post("/verify-email", authLimiter, validateBody(tokenOnlySchema), async (req, res) => {
  await service.verifyEmail((req.body as TokenOnlyInput).token);
  res.json({ message: "Email verified. You can now log in." });
});

router.post("/resend-verification", authLimiter, validateBody(emailOnlySchema), async (req, res) => {
  await service.resendVerification((req.body as EmailOnlyInput).email);
  res.status(202).json({ message: "If that account needs verification, we've sent a new link." });
});

router.post("/login", loginLimiter, validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as LoginInput;
  const result = await service.login(email, password, meta(req));
  setRefreshCookie(res, result.refreshToken);
  res.json({ accessToken: result.accessToken, user: result.user });
});

router.post("/refresh", async (req, res) => {
  try {
    const result = await service.refresh(req.cookies?.[REFRESH_COOKIE], meta(req));
    setRefreshCookie(res, result.refreshToken);
    res.json({ accessToken: result.accessToken });
  } catch (e) {
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    throw e;
  }
});

router.post("/logout", async (req, res) => {
  await service.logout(req.cookies?.[REFRESH_COOKIE], meta(req));
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
  res.status(204).end();
});

router.post("/forgot-password", authLimiter, validateBody(emailOnlySchema), async (req, res) => {
  await service.forgotPassword((req.body as EmailOnlyInput).email);
  res.status(202).json({ message: "If that email is registered, we've sent a reset link." });
});

router.post("/reset-password", authLimiter, validateBody(resetPasswordSchema), async (req, res) => {
  const { token, password } = req.body as ResetPasswordInput;
  await service.resetPassword(token, password, meta(req));
  res.json({ message: "Password updated. Please log in again." });
});

router.get("/me", requireAuth, async (req, res) => {
  res.json(await service.getMe(req.user!.id));
});

export default router;
