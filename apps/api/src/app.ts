import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import { pool } from "./config/db";
import { apiLimiter } from "./middleware/rateLimit";
import { originCheck } from "./middleware/originCheck";
import { errorHandler, notFound } from "./middleware/errorHandler";
import authRoutes from "./modules/auth/auth.routes";
import groupRoutes from "./modules/groups/groups.routes";
import invitationRoutes from "./modules/groups/invitations.routes";
import { loansByIdRoutes } from "./modules/loans/loans.routes";
import { withdrawalsByIdRoutes } from "./modules/withdrawals/withdrawals.routes";
import paymentRoutes from "./modules/payments/payments.routes";
import simulatorRoutes from "./modules/payments/payments.dev.routes";
import { webhookHandler } from "./modules/payments/webhook";

export function createApp() {
  const app = express();

  // Behind Render/Railway there is one proxy; needed so rate limits see real IPs.
  if (env.NODE_ENV === "production") app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));

  // The payment webhook MUST come before express.json(): the signature is computed over the
  // exact raw bytes, and re-serialised JSON would no longer match.
  app.post("/api/payments/webhook", express.raw({ type: "application/json", limit: "1mb" }), webhookHandler);

  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use(originCheck);
  app.use("/api", apiLimiter);

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      time: new Date().toISOString(),
      paymentMode: env.PAYMENT_MODE,
      paymentProvider: env.PAYMENT_PROVIDER,
    });
  });

  app.get("/api/health/db", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ database: "up" });
    } catch (err) {
      console.error("Database health check failed:", err);
      res.status(503).json({ database: "down" });
    }
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/groups", groupRoutes);
  app.use("/api/invitations", invitationRoutes);
  app.use("/api/loans", loansByIdRoutes);
  app.use("/api/withdrawals", withdrawalsByIdRoutes);
  app.use("/api/payments", paymentRoutes);

  // Fake gateway controls: only exist when the simulator is the provider (env.ts forbids that in production).
  if (env.PAYMENT_PROVIDER === "simulator") app.use("/api/dev/simulator", simulatorRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
