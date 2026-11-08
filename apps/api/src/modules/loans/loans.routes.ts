import { Router, type Request } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireLoanAccess } from "../../middleware/requireLoanAccess";
import { requirePermission } from "../../middleware/requirePermission";
import { validateBody, validateQuery } from "../../middleware/validate";
import { serializeDeposit } from "../contributions/deposits.service";
import * as loans from "./loans.service";
import { recordRepayment } from "./repayments.service";
import {
  applyLoanSchema, disburseSchema, loanListQuerySchema, noteSchema, quoteQuerySchema,
  rejectSchema, repaymentSchema,
  type ApplyLoanInput, type DisburseInput, type LoanListQuery, type NoteInput,
  type QuoteQuery, type RejectInput, type RepaymentInput,
} from "./loans.schema";

const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });
const viewerOf = (req: Request) => ({ userId: req.user!.id, role: req.membership!.role });
const actorOf = (req: Request) => ({ id: req.user!.id, name: req.user!.name, role: req.membership!.role });
const loanIdOf = (req: Request) => String(req.params.loanId);

// ───────────── /groups/:groupId/loans (collection) ─────────────
export const loanCollectionRoutes = Router({ mergeParams: true });

loanCollectionRoutes.post("/", requirePermission("loan:apply"), validateBody(applyLoanSchema), async (req, res) => {
  const groupId = req.membership!.groupId;
  const out = await loans.applyForLoan(groupId, { id: req.user!.id, name: req.user!.name }, req.body as ApplyLoanInput, meta(req));
  res.status(out.replayed ? 200 : 201).json({ replayed: out.replayed, loan: await loans.getLoan(groupId, out.loanId, viewerOf(req)) });
});

loanCollectionRoutes.get("/", requirePermission("loan:view_own"), validateQuery(loanListQuerySchema), async (req, res) => {
  res.json(await loans.listLoans(req.membership!.groupId, viewerOf(req), res.locals.query as LoanListQuery));
});

// Fixed paths before anything parameterised.
loanCollectionRoutes.get("/quote", requirePermission("loan:apply"), validateQuery(quoteQuerySchema), async (req, res) => {
  res.json(await loans.quoteLoan(req.membership!.groupId, res.locals.query as QuoteQuery));
});

loanCollectionRoutes.get("/outstanding", requirePermission("loan:view_all"), async (req, res) => {
  res.json(await loans.outstandingReport(req.membership!.groupId));
});

// ───────────── one loan: mounted at /groups/:groupId/loans/:loanId AND /loans/:loanId ─────────────
export const loanItemRoutes = Router({ mergeParams: true });

loanItemRoutes.get("/", requirePermission("loan:view_own"), async (req, res) => {
  res.json({ loan: await loans.getLoan(req.membership!.groupId, loanIdOf(req), viewerOf(req)) });
});

// Approve / reject / disburse need loan:review; the service then applies the "who decides" rule.
loanItemRoutes.post("/review", requirePermission("loan:review"), validateBody(noteSchema), async (req, res) => {
  const groupId = req.membership!.groupId;
  await loans.reviewLoan(groupId, loanIdOf(req), actorOf(req), (req.body as NoteInput).note, meta(req));
  res.json({ loan: await loans.getLoan(groupId, loanIdOf(req), viewerOf(req)) });
});

loanItemRoutes.post("/approve", requirePermission("loan:review"), validateBody(noteSchema), async (req, res) => {
  const groupId = req.membership!.groupId;
  await loans.approveLoan(groupId, loanIdOf(req), actorOf(req), (req.body as NoteInput).note, meta(req));
  res.json({ loan: await loans.getLoan(groupId, loanIdOf(req), viewerOf(req)) });
});

loanItemRoutes.post("/reject", requirePermission("loan:review"), validateBody(rejectSchema), async (req, res) => {
  const groupId = req.membership!.groupId;
  await loans.rejectLoan(groupId, loanIdOf(req), actorOf(req), (req.body as RejectInput).reason, meta(req));
  res.json({ loan: await loans.getLoan(groupId, loanIdOf(req), viewerOf(req)) });
});

loanItemRoutes.post("/disburse", requirePermission("loan:review"), validateBody(disburseSchema), async (req, res) => {
  const groupId = req.membership!.groupId;
  await loans.disburseLoan(groupId, loanIdOf(req), actorOf(req), req.body as DisburseInput, meta(req));
  res.json({ loan: await loans.getLoan(groupId, loanIdOf(req), viewerOf(req)) });
});

loanItemRoutes.post("/cancel", requirePermission("loan:apply"), async (req, res) => {
  const groupId = req.membership!.groupId;
  await loans.cancelLoan(groupId, loanIdOf(req), actorOf(req), meta(req));
  res.json({ loan: await loans.getLoan(groupId, loanIdOf(req), viewerOf(req)) });
});

loanItemRoutes.get("/installments", requirePermission("loan:view_own"), async (req, res) => {
  const loan = await loans.getLoan(req.membership!.groupId, loanIdOf(req), viewerOf(req));
  res.json({
    loanId: loan.id,
    status: loan.status,
    policy: loan.policy,
    totalRepayablePaise: loan.totalRepayablePaise,
    outstandingPaise: loan.outstandingPaise,
    installments: loan.installments,
  });
});

loanItemRoutes.get("/repayments", requirePermission("loan:view_own"), async (req, res) => {
  res.json({ repayments: await loans.listRepayments(req.membership!.groupId, loanIdOf(req), viewerOf(req)) });
});

loanItemRoutes.post("/repayments", requirePermission("repayment:record_manual"), validateBody(repaymentSchema), async (req, res) => {
  const groupId = req.membership!.groupId;
  const result = await recordRepayment(groupId, loanIdOf(req), { id: req.user!.id, name: req.user!.name }, req.body as RepaymentInput, meta(req));
  res.status(result.replayed ? 200 : 201).json({
    replayed: result.replayed,
    repayment: serializeDeposit(result.payment, { evidence: true }),
    loan: await loans.getLoan(groupId, loanIdOf(req), viewerOf(req)),
  });
});

// ───────────── /loans/:loanId (the shorter paths from your spec) ─────────────
// requireLoanAccess finds the loan's group and checks YOU belong to it before anything else runs.
export const loansByIdRoutes = Router();
loansByIdRoutes.use("/:loanId", requireAuth, requireLoanAccess, loanItemRoutes);
