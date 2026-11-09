export type FieldError = { field: string; message: string };

export class ApiError extends Error {
  status: number;
  code: string;
  details: FieldError[];
  constructor(status: number, code: string, message: string, details: FieldError[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// The access token lives ONLY in this variable (memory). A page reload loses it,
// and the HttpOnly refresh cookie quietly gets a new one.
let accessToken: string | null = null;
export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};

let onSessionLost: (() => void) | null = null;
export const setSessionLostHandler = (fn: (() => void) | null): void => {
  onSessionLost = fn;
};

type ErrorBody = { error?: { code?: string; message?: string; details?: unknown } };

async function parseError(res: Response): Promise<ApiError> {
  let body: ErrorBody | null = null;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    body = null;
  }
  const e = body?.error;
  return new ApiError(
    res.status,
    e?.code ?? "ERROR",
    e?.message ?? `Request failed (${res.status})`,
    Array.isArray(e?.details) ? (e.details as FieldError[]) : []
  );
}

// ONE refresh at a time. Every caller that needs a fresh token shares the same promise,
// so parallel requests can never trigger the server's "token reuse" alarm.
let refreshing: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
        if (!res.ok) {
          accessToken = null;
          return false;
        }
        const data = (await res.json()) as { accessToken: string };
        accessToken = data.accessToken;
        return true;
      } catch {
        return false;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

type Options = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean; // false for public endpoints (login, register...)
};

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const { method = "GET", body, headers = {}, auth = true } = opts;

  const send = () =>
    fetch(path, {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(auth && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await send();

  // Expired access token: refresh once, then retry the same request once.
  if (auth && res.status === 401) {
    const err = await parseError(res.clone());
    if (err.code === "TOKEN_EXPIRED" || err.code === "UNAUTHENTICATED") {
      if (await refreshSession()) {
        res = await send();
      } else {
        onSessionLost?.();
        throw err;
      }
    }
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : "Something went wrong. Please try again.";

// Downloads a file (e.g. a CSV) with the login token attached, then saves it in the browser.
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const send = () =>
    fetch(path, {
      credentials: "include",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
  let res = await send();
  if (res.status === 401) {
    if (await refreshSession()) {
      res = await send();
    } else {
      onSessionLost?.();
      throw await parseError(res);
    }
  }
  if (!res.ok) throw await parseError(res);

  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
