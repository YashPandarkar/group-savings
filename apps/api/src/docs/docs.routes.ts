import path from "node:path";
import type { Express } from "express";
import { openApiDocument } from "./openapi";

// The page has NO inline scripts, so it works under the strict Content-Security-Policy.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Group Savings API</title>
<link rel="stylesheet" href="/api/docs/assets/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/api/docs/assets/swagger-ui-bundle.js"></script>
<script src="/api/docs/init.js"></script>
</body>
</html>`;

// persistAuthorization is off: a pasted token is never saved in the browser.
const INIT = `window.ui = SwaggerUIBundle({
  url: "/api/openapi.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
  persistAuthorization: false,
});`;

const ASSETS = new Set(["swagger-ui.css", "swagger-ui-bundle.js"]);

export function mountDocs(app: Express): void {
  app.get("/api/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });
  app.get("/api/docs", (_req, res) => {
    res.type("html").send(PAGE);
  });
  app.get("/api/docs/init.js", (_req, res) => {
    res.type("application/javascript").send(INIT);
  });
  // Only two whitelisted files are served from the swagger-ui-dist package.
  app.get("/api/docs/assets/:file", (req, res, next) => {
    const file = String(req.params.file);
    if (!ASSETS.has(file)) return next();
    const root = path.dirname(require.resolve("swagger-ui-dist/package.json"));
    res.sendFile(file, { root });
  });
}
