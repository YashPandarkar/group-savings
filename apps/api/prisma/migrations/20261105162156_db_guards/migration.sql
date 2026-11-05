-- ============================================================
-- 1. Membership rules
-- ============================================================

-- A user can be ACTIVE in only one group at a time.
CREATE UNIQUE INDEX one_active_group_per_user
  ON "group_members" ("userId")
  WHERE "status" = 'ACTIVE';

-- At most one active President and one active Vice President per group.
-- (Transferring a role: demote the old holder first, then promote, in one transaction.)
CREATE UNIQUE INDEX one_active_president_per_group
  ON "group_members" ("groupId")
  WHERE "role" = 'PRESIDENT' AND "status" = 'ACTIVE';

CREATE UNIQUE INDEX one_active_vice_president_per_group
  ON "group_members" ("groupId")
  WHERE "role" = 'VICE_PRESIDENT' AND "status" = 'ACTIVE';

-- Ledger accounts: one per (group, code), or per (group, code, member).
-- Needed because NULLs are treated as distinct in normal unique indexes.
CREATE UNIQUE INDEX ledger_account_group_code
  ON "ledger_accounts" ("groupId", "code")
  WHERE "userId" IS NULL;

CREATE UNIQUE INDEX ledger_account_member_code
  ON "ledger_accounts" ("groupId", "code", "userId")
  WHERE "userId" IS NOT NULL;

-- ============================================================
-- 2. Sanity checks on values
-- ============================================================

ALTER TABLE "groups"
  ADD CONSTRAINT groups_max_members_chk CHECK ("maxMembers" BETWEEN 10 AND 20),
  ADD CONSTRAINT groups_contribution_chk CHECK ("monthlyContributionPaise" > 0),
  ADD CONSTRAINT groups_due_day_chk CHECK ("contributionDueDay" BETWEEN 1 AND 28),
  ADD CONSTRAINT groups_interest_chk CHECK ("interestRateBps" BETWEEN 0 AND 10000);

ALTER TABLE "contributions"
  ADD CONSTRAINT contributions_amounts_chk CHECK ("expectedPaise" > 0 AND "paidPaise" >= 0),
  ADD CONSTRAINT contributions_period_chk CHECK ("periodMonth" BETWEEN 1 AND 12);

ALTER TABLE "payment_orders"
  ADD CONSTRAINT payment_orders_amount_chk CHECK ("amountPaise" > 0);

ALTER TABLE "payment_transactions"
  ADD CONSTRAINT payment_transactions_amount_chk CHECK ("amountPaise" > 0);

ALTER TABLE "loans"
  ADD CONSTRAINT loans_amount_chk CHECK ("principalPaise" > 0),
  ADD CONSTRAINT loans_installments_chk CHECK ("installmentCount" > 0),
  ADD CONSTRAINT loans_interest_chk CHECK ("interestRateBps" BETWEEN 0 AND 10000);

ALTER TABLE "loan_installments"
  ADD CONSTRAINT loan_installments_amounts_chk
  CHECK ("principalPaise" >= 0 AND "interestPaise" >= 0 AND "paidPaise" >= 0
         AND "totalDuePaise" = "principalPaise" + "interestPaise");

ALTER TABLE "loan_repayments"
  ADD CONSTRAINT loan_repayments_amount_chk
  CHECK ("amountPaise" > 0 AND "amountPaise" = "principalPortionPaise" + "interestPortionPaise");

ALTER TABLE "withdrawals"
  ADD CONSTRAINT withdrawals_amount_chk CHECK ("amountPaise" > 0);

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT ledger_entries_amount_chk CHECK ("amountPaise" > 0);

-- ============================================================
-- 3. Append-only tables (ledger and audit log)
-- ============================================================

CREATE OR REPLACE FUNCTION forbid_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on "%" is not allowed: this table is append-only. Create a reversal instead.',
    TG_OP, TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

CREATE TRIGGER ledger_journals_append_only
  BEFORE UPDATE OR DELETE ON "ledger_journals"
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER ledger_journals_no_truncate
  BEFORE TRUNCATE ON "ledger_journals"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

-- ============================================================
-- 4. Every journal must balance and stay inside one group
--    Deferred: checked at COMMIT, so entries can be inserted one by one.
-- ============================================================

CREATE OR REPLACE FUNCTION check_journal_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total_debit  BIGINT;
  total_credit BIGINT;
  mismatched   INTEGER;
BEGIN
  SELECT COALESCE(SUM("amountPaise") FILTER (WHERE "direction" = 'DEBIT'), 0),
         COALESCE(SUM("amountPaise") FILTER (WHERE "direction" = 'CREDIT'), 0)
    INTO total_debit, total_credit
    FROM "ledger_entries"
   WHERE "journalId" = NEW."journalId";

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal % is unbalanced: debits=% credits=%',
      NEW."journalId", total_debit, total_credit;
  END IF;

  SELECT COUNT(*) INTO mismatched
    FROM "ledger_entries" e
    JOIN "ledger_journals" j ON j."id" = e."journalId"
    JOIN "ledger_accounts" a ON a."id" = e."accountId"
   WHERE e."journalId" = NEW."journalId"
     AND (e."groupId" <> j."groupId" OR a."groupId" <> j."groupId");

  IF mismatched > 0 THEN
    RAISE EXCEPTION 'Journal % mixes entries or accounts from different groups', NEW."journalId";
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_integrity();
