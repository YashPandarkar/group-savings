import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/requireAuth";
import { validateQuery } from "../../middleware/validate";
import * as notifications from "./notifications.service";
import type { NotificationQuery } from "./notifications.service";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  unread: z.enum(["true", "false"]).optional(),
});

const router = Router();
router.use(requireAuth); // every route is about the logged-in user's own notifications

router.get("/", validateQuery(querySchema), async (req, res) => {
  res.json(await notifications.listNotifications(req.user!.id, res.locals.query as NotificationQuery));
});

// Fixed paths before "/:id/read".
router.get("/unread-count", async (req, res) => {
  res.json({ unread: await notifications.unreadCount(req.user!.id) });
});

router.post("/read-all", async (req, res) => {
  res.json(await notifications.markAllRead(req.user!.id));
});

router.post("/:id/read", async (req, res) => {
  res.json(await notifications.markRead(req.user!.id, String(req.params.id)));
});

export default router;
