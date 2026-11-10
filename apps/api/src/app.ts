import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import { pool } from "./config/db";
import { apiLimiter } from "./middleware/rateLimit";
import { originCheck } from "./middleware/originCheck";
import { errorHandler, notFound } from "./middleware/errorHandler";
import { mountDocs } from "./docs/docs.routes";
import { mountWeb } from "./lib/serveWeb";
import authRoutes from "./modules/auth/auth.routes";
import accountRoutes from "./modules/account/account.routes";
import groupRoutes from "./modules/groups/groups.routes";
import invitationRoutes from "./modules/groups/invitations.routes";
import { loansByIdRoutes } from "./modules/loans/loans.routes";
import { withdrawalsByIdRoutes } from "./modules/withdrawals/withdrawals.routes";
import notificationRoutes from "./modules/notifications/notifications.routes";
import paymentRoutes from "./modules/payments/payments.routes";
import simulatorRoutes from "./modules/payments/payments.dev.routes";
import { webhookHandler } from "./modules/payments/webhook";

export type AppOptions = {
  // undefined = decide from SERVE_WEB / WEB_DIST; a path = serve that folder; null = never serve the web app
  serveWebFrom?: string | null;
};

// Helmet's defaults, adjusted: no upgrade-insecure-requests outside production (it breaks plain-http
// localhost), and the Razorpay checkout hosts only when Razorpay is actually in use.
function contentSecurityPolicy(): Record<string, string[] | null> {
  const directives: Record<string, string[] | null> = {};
  for (const [name, values] of Object.entries(helmet.contentSecurityPolicy.getDefaultDirectives())) {
    directives[name] = Array.from(values) as string[];
  }
  if (env.NODE_ENV !== "production") directives["upgrade-insecure-requests"] = null;
  if (env.PAYMENT_PROVIDER === "razorpay") {
    directives["script-src"] = ["'self'", "https://checkout.razorpay.com"];
    directives["frame-src"] = ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com"];
    directives["connect-src"] = ["'self'", "https://api.razorpay.com", "https://lumberjack.razorpay.com"];
    directives["img-src"] = ["'self'", "data:", "https:"];
  }
  return directives;
}

export function createApp(opts: AppOptions = {}) {
  const app = express();

  // Behind Render/Railway there is one proxy; needed so rate limits see real IPs.
  if (env.NODE_ENV === "production") app.set("trust proxy", 1);

  app.use(helmet({ contentSecurityPolicy: { directives: contentSecurityPolicy() } }));
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

  // API documentation (not mounted in production).
  if (env.NODE_ENV !== "production") mountDocs(app);

  app.use("/api/auth", authRoutes);
  app.use("/api/auth", accountRoutes);
  app.use("/api/groups", groupRoutes);
  app.use("/api/invitations", invitationRoutes);
  app.use("/api/loans", loansByIdRoutes);
  app.use("/api/withdrawals", withdrawalsByIdRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/payments", paymentRoutes);

  // Fake gateway controls: only exist when the simulator is the provider (env.ts forbids that in production).
  if (env.PAYMENT_PROVIDER === "simulator") app.use("/api/dev/simulator", simulatorRoutes);

  // The built web app (single origin). After every API route, before the 404 handler.
  const fromEnv = env.SERVE_WEB ? path.resolve(env.WEB_DIST ?? path.resolve(process.cwd(), "../web/dist")) : null;
  const webDist = opts.serveWebFrom === undefined ? fromEnv : opts.serveWebFrom;
  if (webDist) mountWeb(app, webDist);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
