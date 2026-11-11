import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit and component tests only. The browser tests in e2e/ are run by Playwright.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
