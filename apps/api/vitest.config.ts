import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false, // tests share one database
    env: {
      NODE_ENV: "test",
      DATABASE_URL:
        "postgresql://groupsavings:change_me_local_only@localhost:5432/groupsavings_test",
      JWT_ACCESS_SECRET: "test-only-secret-test-only-secret-1234",
      WEB_ORIGIN: "http://localhost:5173",
    },
  },
});
