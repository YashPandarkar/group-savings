import { Router, type Request } from "express";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody, validateQuery } from "../../middleware/validate";
import * as deposits from "./deposits.service";
import { manualDepositSchema, pageQuerySchema, type ManualDepositInput, type PageQuery } from "./contributions.schema";

const router = Router({ mergeParams: true });
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });

// President or VP records money that really arrived.
router.post("/manual", requirePermission("deposit:record_manual"), validateBody(manualDepositSchema), async (req, res) => {
  const result = await deposits.recordManualDeposit(
    req.membership!.groupId,
    { id: req.user!.id, name: req.user!.name },
    req.body as ManualDepositInput,
    meta(req)
  );
  res
    .status(result.replayed ? 200 : 201)
    .json({ replayed: result.replayed, deposit: deposits.serializeDeposit(result.payment, { evidence: true }) });
});

router.get("/", requirePermission("contribution:view_own"), validateQuery(pageQuerySchema), async (req, res) => {
  const { groupId, role } = req.membership!;
  const { page, pageSize } = res.locals.query as PageQuery;
  res.json(await deposits.listDeposits(groupId, { userId: req.user!.id, role }, page, pageSize));
});

export default router;
