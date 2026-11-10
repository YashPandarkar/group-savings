import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { app } from "./helpers";

const WEB_ORIGIN = "http://localhost:5173";

describe("CORS", () => {
  it("allows the web app's origin with credentials on a preflight", async () => {
    const res = await request(app)
      .options("/api/auth/login")
      .set("Origin", WEB_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,authorization");
    expect(res.status).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("never reflects a foreign origin and never answers with a wildcard", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://evil.example");
    const allowed = res.headers["access-control-allow-origin"];
    expect(allowed).toBe(WEB_ORIGIN); // the browser will refuse to hand this to evil.example
    expect(allowed).not.toBe("*");
    expect(allowed).not.toBe("https://evil.example");
  });
});

describe("security headers", () => {
  it("sets the hardening headers and a strict CSP", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    const csp = res.headers["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("upgrade-insecure-requests"); // development and test only
  });
});

describe("error shape", () => {
  it("every error is {error: {code, message}}", async () => {
    const shapes = [
      await request(app).get("/api/does-not-exist"),
      await request(app).get("/api/auth/me"),
      await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{bad json"),
      await request(app).post("/api/auth/login").send({}),
    ];
    expect(shapes.map((r) => r.status)).toEqual([404, 401, 400, 400]);
    for (const r of shapes) {
      expect(typeof r.body.error.code).toBe("string");
      expect(typeof r.body.error.message).toBe("string");
    }
    expect(shapes[0].body.error.code).toBe("NOT_FOUND");
    expect(shapes[2].body.error.code).toBe("INVALID_JSON");
  });
});

describe("serving the built web app from the API", () => {
  let dir = "";
  let web: ReturnType<typeof createApp>;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-dist-"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log('app');");
    web = createApp({ serveWebFrom: dir });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("serves the app at the root and for deep links (client-side routes)", async () => {
    for (const url of ["/", "/loans/123", "/members"]) {
      const res = await request(web).get(url);
      expect(res.status, url).toBe(200);
      expect(res.text).toContain('<div id="root">');
      expect(res.headers["cache-control"]).toContain("no-cache");
    }
  });

  it("caches hashed assets for a year, and a missing file is a real 404, not the app", async () => {
    const asset = await request(web).get("/assets/app-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toMatch(/javascript/);
    expect(asset.headers["cache-control"]).toContain("immutable");

    const missing = await request(web).get("/assets/nope.js");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("keeps the API intact: unknown API paths are JSON 404s and real ones still work", async () => {
    const unknown = await request(web).get("/api/does-not-exist");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");
    expect((await request(web).get("/api/health")).status).toBe(200);
    expect((await request(web).post("/members")).status).toBe(404); // only GET serves pages
  });

  it("is off by default (the API alone answers 404 at the root)", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("refuses to start when the web app hasn't been built", () => {
    expect(() => createApp({ serveWebFrom: path.join(dir, "missing") })).toThrow(/npm run build/);
  });
});
