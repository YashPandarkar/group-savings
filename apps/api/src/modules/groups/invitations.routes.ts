import { Router, type Request } from "express";
import { validateBody } from "../../middleware/validate";
import { requireAuth } from "../../middleware/requireAuth";
import { authLimiter } from "../../middleware/rateLimit";
import * as invitations from "./invitations.service";
import { invitationTokenSchema, type InvitationTokenInput } from "./groups.schema";

const router = Router();
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });

// Public: shows which group the link is for. (The token is the proof of access.)
router.post("/preview", authLimiter, validateBody(invitationTokenSchema), async (req, res) => {
  res.json(await invitations.previewInvitation((req.body as InvitationTokenInput).token));
});

router.post("/accept", authLimiter, requireAuth, validateBody(invitationTokenSchema), async (req, res) => {
  const result = await invitations.acceptInvitation(req.user!, (req.body as InvitationTokenInput).token, meta(req));
  res.json(result);
});

export default router;
