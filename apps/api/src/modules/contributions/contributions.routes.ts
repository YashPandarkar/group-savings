import { Router } from "express";
import { requirePermission } from "../../middleware/requirePermission";
import { validateQuery } from "../../middleware/validate";
import * as contributions from "./contributions.service";
import { periodQuerySchema, type PeriodQuery } from "./contributions.schema";

const router = Router({ mergeParams: true });

// Monthly collection dashboard: President and VP.
router.get("/", requirePermission("contribution:view_all"), validateQuery(periodQuerySchema), async (req, res) => {
  const { year, month } = res.locals.query as PeriodQuery;
  res.json(await contributions.getPeriodOverview(req.membership!.groupId, year, month));
});

// Everyone can see their own history. (Must be declared BEFORE "/:memberId".)
router.get("/me", requirePermission("contribution:view_own"), async (req, res) => {
  res.json({ items: await contributions.getHistoryForUser(req.membership!.groupId, req.user!.id) });
});

// One member's history: President and VP.
router.get("/:memberId", requirePermission("contribution:view_all"), async (req, res) => {
  res.json(await contributions.getHistoryForMembership(req.membership!.groupId, String(req.params.memberId)));
});

export default router;
