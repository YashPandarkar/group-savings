import { env } from "./config/env";
import { pool } from "./config/db";
import { createApp } from "./app";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(
    `✅ API running on http://localhost:${env.PORT} ` +
      `(env: ${env.NODE_ENV}, payments: ${env.PAYMENT_MODE})`
  );
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
