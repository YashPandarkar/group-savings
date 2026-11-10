import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";

// Serves the built React app from the API, so the browser sees ONE origin
// (no CORS, and the SameSite=Strict refresh cookie works). Mount AFTER all API routes.
export function mountWeb(app: Express, dist: string): void {
  const index = path.join(dist, "index.html");
  if (!fs.existsSync(index)) {
    throw new Error(`SERVE_WEB is on, but ${index} doesn't exist. Build the web app first: npm run build -w apps/web`);
  }

  // Vite names files assets/<name>-<hash>.js, so they can be cached "forever".
  app.use("/assets", express.static(path.join(dist, "assets"), { immutable: true, maxAge: "1y" }));
  app.use(express.static(dist, { index: false, maxAge: "1h" })); // favicon and other root files

  // Any other page URL (/loans/123, /members...) is a React route: send the app and let it decide.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path === "/api" || req.path.startsWith("/api/")) return next(); // unknown API paths stay JSON 404s
    if (path.extname(req.path) !== "") return next(); // a missing file is a real 404, not the app
    res.setHeader("Cache-Control", "no-cache"); // always pick up a new deployment
    res.sendFile("index.html", { root: dist });
  });
}
