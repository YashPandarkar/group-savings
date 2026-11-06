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

export function createApp() {
  const app = express();

  // Behind Render/Railway there is one proxy; needed so rate limits see real IPs.
  if (env.NODE_ENV === "production") app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));

  // Phase 9: the Razorpay webhook route goes HERE, before express.json,
  // because signature checks need the exact raw request body.

  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use(originCheck);
  app.use("/api", apiLimiter);

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString(), paymentMode: env.PAYMENT_MODE });
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

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
