import { Router, type Request } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { authLimiter } from "../../middleware/rateLimit";
import { validateBody } from "../../middleware/validate";
import * as account from "./account.service";
import {
  changePasswordSchema,
  profileSchema,
  type ChangePasswordInput,
  type ProfileInput,
} from "./account.schema";

const router = Router();
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });

router.patch("/profile", requireAuth, validateBody(profileSchema), async (req, res) => {
  const user = await account.updateProfile(req.user!.id, (req.body as ProfileInput).name, meta(req));
  res.json({ user });
});

// authLimiter slows down anyone guessing the current password with a stolen access token.
router.post("/change-password", requireAuth, authLimiter, validateBody(changePasswordSchema), async (req, res) => {
  const { currentPassword, newPassword } = req.body as ChangePasswordInput;
  await account.changePassword(req.user!.id, currentPassword, newPassword, req.cookies?.rt, meta(req));
  res.json({ message: "Password changed. Your other devices have been logged out." });
});

export default router;
