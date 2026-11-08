import { Router, type Request } from "express";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody, validateQuery } from "../../middleware/validate";
import * as transactions from "./transactions.service";
import { reverseTransaction } from "./reversals.service";
import { reverseSchema, txListQuerySchema, type ReverseInput, type TxListQuery } from "./ledger.schema";

const router = Router({ mergeParams: true });
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });
const viewerOf = (req: Request) => ({ userId: req.user!.id, role: req.membership!.role });

// Fixed paths first, then "/:transactionId".
router.get("/summary", requirePermission("balance:view"), async (req, res) => {
  res.json(await transactions.getSummary(req.membership!.groupId, req.user!.id));
});

router.get("/export.csv", requirePermission("transactions:view_group"), validateQuery(txListQuerySchema), async (req, res) => {
  const out = await transactions.exportCsv(req.membership!.groupId, viewerOf(req), res.locals.query as TxListQuery, meta(req));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
  res.send(out.csv);
});

router.get("/", requirePermission("transactions:view_group"), validateQuery(txListQuerySchema), async (req, res) => {
  res.json(await transactions.listTransactions(req.membership!.groupId, viewerOf(req), res.locals.query as TxListQuery));
});

router.get("/:transactionId", requirePermission("transactions:view_group"), async (req, res) => {
  res.json(await transactions.getTransaction(req.membership!.groupId, String(req.params.transactionId), viewerOf(req)));
});

router.post("/:transactionId/reverse", requirePermission("transaction:reverse"), validateBody(reverseSchema), async (req, res) => {
  const out = await reverseTransaction(
    req.membership!.groupId,
    String(req.params.transactionId),
    { id: req.user!.id, name: req.user!.name },
    (req.body as ReverseInput).reason,
    meta(req)
  );
  res.status(201).json(out);
});

export default router;
