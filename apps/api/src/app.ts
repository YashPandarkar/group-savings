import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env";
import { pool } from "./config/db";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      time: new Date().toISOString(),
      paymentMode: env.PAYMENT_MODE,
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

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
