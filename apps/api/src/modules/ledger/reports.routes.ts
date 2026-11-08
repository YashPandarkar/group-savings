import { Router } from "express";
import { requirePermission } from "../../middleware/requirePermission";
import { validateQuery } from "../../middleware/validate";
import * as reports from "./reports.service";
import { yearQuerySchema, type YearQuery } from "./ledger.schema";

const router = Router({ mergeParams: true });

// President and VP only.
router.get("/fund", requirePermission("report:view"), async (req, res) => {
  res.json(await reports.fundReport(req.membership!.groupId));
});

router.get("/monthly", requirePermission("report:view"), validateQuery(yearQuerySchema), async (req, res) => {
  res.json(await reports.monthlySavings(req.membership!.groupId, (res.locals.query as YearQuery).year));
});

router.get("/integrity", requirePermission("report:view"), async (req, res) => {
  res.json(await reports.integrityReport(req.membership!.groupId));
});

export default router;
