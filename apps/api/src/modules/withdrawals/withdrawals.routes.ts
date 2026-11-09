import { Router, type Request } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireWithdrawalAccess } from "../../middleware/requireWithdrawalAccess";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody, validateQuery } from "../../middleware/validate";
import * as wd from "./withdrawals.service";
import {
  completeSchema, noteSchema, rejectSchema, requestWithdrawalSchema, withdrawalListQuerySchema,
  type CompleteInput, type NoteInput, type RejectInput, type RequestWithdrawalInput, type WithdrawalListQuery,
} from "./withdrawals.schema";

const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });
const viewerOf = (req: Request) => ({ userId: req.user!.id, role: req.membership!.role });
const actorOf = (req: Request) => ({ id: req.user!.id, name: req.user!.name, role: req.membership!.role });
const idOf = (req: Request) => String(req.params.withdrawalId);

// /groups/:groupId/withdrawals
export const withdrawalCollectionRoutes = Router({ mergeParams: true });

withdrawalCollectionRoutes.post("/", requirePermission("withdrawal:request"), validateBody(requestWithdrawalSchema), async (req, res) => {
  const groupId = req.membership!.groupId;
  const out = await wd.requestWithdrawal(groupId, actorOf(req), req.body as RequestWithdrawalInput, meta(req));
  res.status(out.replayed ? 200 : 201).json({
    replayed: out.replayed,
    withdrawal: await wd.getWithdrawal(groupId, out.id, viewerOf(req)),
  });
});

withdrawalCollectionRoutes.get("/", requirePermission("group:view"), validateQuery(withdrawalListQuerySchema), async (req, res) => {
  res.json(await wd.listWithdrawals(req.membership!.groupId, viewerOf(req), res.locals.query as WithdrawalListQuery));
});

withdrawalCollectionRoutes.get("/report", requirePermission("report:view"), async (req, res) => {
  res.json(await wd.withdrawalReport(req.membership!.groupId));
});

// One withdrawal: at /groups/:groupId/withdrawals/:id and at /withdrawals/:id
export const withdrawalItemRoutes = Router({ mergeParams: true });

withdrawalItemRoutes.get("/", requirePermission("group:view"), async (req, res) => {
  res.json({ withdrawal: await wd.getWithdrawal(req.membership!.groupId, idOf(req), viewerOf(req)) });
});

withdrawalItemRoutes.post("/approve", requirePermission("withdrawal:approve"), validateBody(noteSchema), async (req, res) => {
  const groupId = req.membership!.groupId;
  await wd.approveWithdrawal(groupId, idOf(req), actorOf(req), (req.body as NoteInput).note, meta(req));
  res.json({ withdrawal: await wd.getWithdrawal(groupId, idOf(req), viewerOf(req)) });
});

withdrawalItemRoutes.post("/reject", requirePermission("withdrawal:approve"), validateBody(rejectSchema), async (req, res) => {
  const groupId = req.membership!.groupId;
  await wd.rejectWithdrawal(groupId, idOf(req), actorOf(req), (req.body as RejectInput).reason, meta(req));
  res.json({ withdrawal: await wd.getWithdrawal(groupId, idOf(req), viewerOf(req)) });
});

withdrawalItemRoutes.post("/cancel", requirePermission("withdrawal:request"), async (req, res) => {
  const groupId = req.membership!.groupId;
  await wd.cancelWithdrawal(groupId, idOf(req), actorOf(req), meta(req));
  res.json({ withdrawal: await wd.getWithdrawal(groupId, idOf(req), viewerOf(req)) });
});

withdrawalItemRoutes.post("/complete", requirePermission("withdrawal:request"), validateBody(completeSchema), async (req, res) => {
  const groupId = req.membership!.groupId;
  const out = await wd.completeWithdrawal(groupId, idOf(req), actorOf(req), req.body as CompleteInput, meta(req));
  res.json({ replayed: out.replayed, withdrawal: await wd.getWithdrawal(groupId, idOf(req), viewerOf(req)) });
});

// /withdrawals/:withdrawalId (the shorter paths from your spec)
export const withdrawalsByIdRoutes = Router();
withdrawalsByIdRoutes.use("/:withdrawalId", requireAuth, requireWithdrawalAccess, withdrawalItemRoutes);
