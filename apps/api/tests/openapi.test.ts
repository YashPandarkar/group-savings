import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "./helpers";
import { openApiDocument, schemaFallbacks } from "../src/docs/openapi";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;
const doc = openApiDocument as Json;
const UUID = "00000000-0000-4000-8000-000000000000";

const ops = Object.entries(doc.paths as Json).flatMap(([p, item]) =>
  Object.entries(item as Json).map(([m, op]) => ({ p, m, op: op as Json }))
);

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}
const resolve = (r: string): unknown => r.replace(/^#\//, "").split("/").reduce<any>((o, k) => o?.[k], doc);

describe("the OpenAPI document", () => {
  it("is generated from the real Zod schemas without fallbacks", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(schemaFallbacks).toEqual([]);
    expect(ops.length).toBeGreaterThan(70);
  });

  it("has no dangling $refs and unique operation ids", () => {
    for (const r of collectRefs(doc)) expect(resolve(r), `unresolved ${r}`).toBeTruthy();
    const ids = ops.map((o) => o.op.operationId as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every operation is described, and every logged-in one documents 401", () => {
    for (const { m, p, op } of ops) {
      expect(op.summary, `${m} ${p}`).toBeTruthy();
      expect(op.tags?.length, `${m} ${p}`).toBe(1);
      expect(Object.keys(op.responses).length, `${m} ${p}`).toBeGreaterThan(0);
      if (JSON.stringify(op.security) === JSON.stringify([{ bearerAuth: [] }])) {
        expect(op.responses["401"], `${m} ${p}`).toBeTruthy();
      }
    }
  });

  it("request schemas come from the real validation rules", () => {
    const register = doc.paths["/api/auth/register"].post.requestBody.content["application/json"].schema;
    expect(register.required).toEqual(expect.arrayContaining(["name", "email", "password"]));

    const list = doc.paths["/api/groups/{groupId}/transactions"].get.parameters as Json[];
    const type = list.find((p) => p.name === "type");
    expect(type?.in).toBe("query");
    expect(JSON.stringify(type?.schema)).toContain("MONTHLY_DEPOSIT");
    expect(list.some((p) => p.in === "path" && p.name === "groupId")).toBe(true);

    const order = doc.paths["/api/payments/create-order"].post.parameters as Json[];
    expect(order.some((p) => p.name === "Idempotency-Key" && p.required)).toBe(true);
    expect(doc.paths["/api/payments/webhook"].post.security).toEqual([]);
    expect(doc.info.description).toContain("paise");
  });
});

describe("every documented route really exists", () => {
  // Called without a login: a real route answers 400/401/etc. Only a missing route answers 404.
  it.each(ops.map((o) => [`${o.m.toUpperCase()} ${o.p}`, o] as const))("%s is routed", async (_name, o) => {
    const url = o.p.replace(/\{\w+\}/g, UUID);
    let req = (request(app) as any)[o.m](url);
    if (o.m !== "get") req = req.set("Content-Type", "application/json").send("{}");
    const res = await req;
    expect(res.status, `${o.m} ${url}`).not.toBe(404);
    expect(res.status, `${o.m} ${url}`).toBeLessThan(500);
  });
});

describe("the docs page", () => {
  it("serves the spec and a page that works under the strict CSP (no inline scripts)", async () => {
    const spec = await request(app).get("/api/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe("3.1.0");

    const page = await request(app).get("/api/docs");
    expect(page.status).toBe(200);
    expect(page.text).toContain("/api/docs/assets/swagger-ui-bundle.js");
    expect(page.text).not.toMatch(/<script(?![^>]*\bsrc=)/);

    const init = await request(app).get("/api/docs/init.js");
    expect(init.status).toBe(200);
    expect(init.text).toContain("/api/openapi.json");
    expect(init.text).toContain("persistAuthorization: false");
  });

  it("serves only the two whitelisted Swagger files", async () => {
    expect((await request(app).get("/api/docs/assets/swagger-ui.css")).status).toBe(200);
    expect((await request(app).get("/api/docs/assets/swagger-ui-bundle.js")).status).toBe(200);
    const other = await request(app).get("/api/docs/assets/package.json");
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe("NOT_FOUND");
  });
});
