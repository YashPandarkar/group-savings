# Production readiness checklist

Do not enable real money until every item in **Legal and provider** is done.

## Legal and provider (blocking)
- [ ] A lawyer or chartered accountant has reviewed: state money-lending law, deposit and cooperative rules, payment-aggregator rules, KYC, and data protection for this exact use.
- [ ] Group funds stay in a bank account legally held by the group (or an authorised provider). The app only keeps records.
- [ ] Razorpay (or the chosen provider) has approved your business model and KYC. Test payments, refunds and webhooks verified in test mode.
- [ ] A written procedure exists for refunds, disputes and corrections (the app flags them; people resolve them).
- [ ] Members are told clearly that the app records transactions and does not hold money.
- [ ] `LEGAL_REVIEW_CONFIRMED=true` is set only after the above.

## Application
- [ ] All tests green: API, web, E2E (`npm test`, `npm run e2e`).
- [ ] Production environment variables set from the host's secret store (see `.env.example`); fresh `JWT_ACCESS_SECRET` and `DATA_ENCRYPTION_KEY`; keys backed up separately from the database backups.
- [ ] Real email provider connected (the app logs nothing sensitive and sends nothing until this is done).
- [ ] Database migrations applied with `prisma migrate deploy`; no seed or demo data in production.
- [ ] Scheduled jobs running: contribution generation, loan status sync, payment reconciliation.
- [ ] API docs not exposed publicly (they are off when NODE_ENV=production).

## Infrastructure
- [ ] HTTPS everywhere; the web app and API share one site (the refresh cookie is SameSite=Strict).
- [ ] Managed PostgreSQL with automated backups, and a restore that has been tested at least once.
- [ ] Error logging and uptime monitoring; alerts to a person.
- [ ] Webhook URL configured at the provider and reachable over HTTPS; webhook secret set.
- [ ] Resource limits and one instance (or a shared rate-limit store if more).

## Before launch
- [ ] External security review or penetration test.
- [ ] Dependency audit clean of high and critical issues; secret scan clean.
- [ ] Reconcile the app's fund balance with the bank statement; agree who does this and how often.
- [ ] At least two administrators per group (a Vice President is appointed), so separation of duties works.
- [ ] Support contact and an incident-response plan (who rotates keys, who tells members).
