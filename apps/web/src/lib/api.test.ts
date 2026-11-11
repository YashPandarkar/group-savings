import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, setAccessToken, setSessionLostHandler } from "./api";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const expired = () => json(401, { error: { code: "TOKEN_EXPIRED", message: "Session expired." } });
const authOf = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

function mockFetch(handler: Handler) {
  const fn = vi.fn((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init ?? {})));
  vi.stubGlobal("fetch", fn);
  return fn;
}
const callsTo = (fn: ReturnType<typeof mockFetch>, path: string) =>
  fn.mock.calls.filter(([u]) => String(u) === path).length;

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
  setSessionLostHandler(null);
});

describe("api(): token refresh", () => {
  it("parallel requests that all hit an expired token share ONE refresh", async () => {
    setAccessToken("old");
    const fn = mockFetch(async (url, init) => {
      if (url === "/api/auth/refresh") {
        await new Promise((r) => setTimeout(r, 30)); // slow enough that every caller joins it
        return json(200, { accessToken: "new" });
      }
      return authOf(init) === "Bearer new" ? json(200, { path: url }) : expired();
    });

    const results = await Promise.all([
      api<{ path: string }>("/api/a"),
      api<{ path: string }>("/api/b"),
      api<{ path: string }>("/api/c"),
    ]);

    expect(results.map((r) => r.path)).toEqual(["/api/a", "/api/b", "/api/c"]); // each was retried with the new token
    expect(callsTo(fn, "/api/auth/refresh")).toBe(1); // a second refresh would trip the server's reuse alarm
  });

  it("when the refresh fails, the session-lost handler runs and the caller gets the original error", async () => {
    setAccessToken("old");
    const lost = vi.fn();
    setSessionLostHandler(lost);
    mockFetch(async (url) =>
      url === "/api/auth/refresh" ? json(401, { error: { code: "UNAUTHENTICATED", message: "Please log in." } }) : expired()
    );

    const err = await api("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("TOKEN_EXPIRED");
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it("other 401s (like a wrong password) are shown, not mistaken for an expired session", async () => {
    setAccessToken("tok");
    const fn = mockFetch(async () => json(401, { error: { code: "INVALID_CREDENTIALS", message: "Incorrect email or password." } }));
    const err = await api("/api/x").catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("INVALID_CREDENTIALS");
    expect(callsTo(fn, "/api/auth/refresh")).toBe(0);
  });

  it("public calls send no token and never try to refresh", async () => {
    setAccessToken("secret-token");
    const fn = mockFetch(async () => expired());
    await expect(api("/api/auth/login", { method: "POST", body: {}, auth: false })).rejects.toBeInstanceOf(ApiError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(authOf(fn.mock.calls[0][1] as RequestInit)).toBeUndefined();
  });
});

describe("api(): requests and errors", () => {
  it("sends the token and JSON, and treats 204 as 'no content'", async () => {
    setAccessToken("tok");
    const fn = mockFetch(async () => new Response(null, { status: 204 }));
    await expect(api("/api/x", { method: "POST", body: { a: 1 } })).resolves.toBeUndefined();
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(authOf(init)).toBe("Bearer tok");
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("turns validation errors into an ApiError with field details", async () => {
    mockFetch(async () =>
      json(400, { error: { code: "VALIDATION_ERROR", message: "Check the fields.", details: [{ field: "email", message: "Invalid" }] } })
    );
    const err = (await api("/api/x").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.details).toEqual([{ field: "email", message: "Invalid" }]);
  });

  it("copes with a non-JSON error page (e.g. a proxy's 502)", async () => {
    mockFetch(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    const err = (await api("/api/x").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("ERROR");
    expect(err.message).toBe("Request failed (502)");
  });
});
