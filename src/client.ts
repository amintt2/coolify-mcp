import type { Config } from "./config.js";

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Human description of the target, used in 404 messages (e.g. `application "web" (abc123)`). */
  resource?: string;
}

/** Error whose message is safe to show to the agent (token already redacted). */
export class CoolifyError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CoolifyError";
    this.status = status;
  }
}

/** Remove the token and any bearer credential from arbitrary text. */
export function redact(text: string, token?: string): string {
  let out = text;
  if (token && token.length >= 4) out = out.split(token).join("[REDACTED]");
  out = out.replace(/(authorization["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',}]+/gi, "$1[REDACTED]");
  out = out.replace(/bearer\s+[A-Za-z0-9._|~+/=-]{8,}/gi, "Bearer [REDACTED]");
  return out;
}

function bodyMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string") {
    return (body as { message: string }).message;
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 500);
  return undefined;
}

function validationDetails(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const errors = (body as { errors?: unknown }).errors;
  if (!errors || typeof errors !== "object") return "";
  const parts: string[] = [];
  for (const [field, msgs] of Object.entries(errors as Record<string, unknown>)) {
    const list = Array.isArray(msgs) ? msgs.map(String) : [String(msgs)];
    parts.push(`${field}: ${list.join(" ")}`);
  }
  return parts.join("; ");
}

/** Turn an HTTP failure into a message an agent can act on. */
export function mapHttpError(status: number, body: unknown, method: string, path: string, resource?: string): string {
  const msg = bodyMessage(body);
  const where = `${method} ${path}`;
  switch (status) {
    case 400:
      if (msg && /invalid token/i.test(msg)) {
        return `Coolify rejected the token ("${msg}"): token invalid or lacks permission — Coolify: Keys & Tokens, needs read + write (+ deploy).`;
      }
      return `Coolify refused the request (400) on ${where}: ${msg ?? "bad request"}.`;
    case 401:
      return "Coolify returned 401: token invalid or lacks permission — Coolify: Keys & Tokens, needs read + write (+ deploy).";
    case 403: {
      if (msg && /api is disabled/i.test(msg)) {
        return "Coolify returned 403: the API is disabled on this instance. Enable it in Coolify: Settings -> Advanced -> API Access.";
      }
      if (msg && /not allowed to access the api/i.test(msg)) {
        return "Coolify returned 403: this machine's IP is not in the API allow-list (Coolify: Settings -> Advanced -> Allowed IPs).";
      }
      return `Coolify returned 403 on ${where}: ${msg ?? "forbidden"}. Check the token's permissions (Keys & Tokens): read for listing, write for env changes, deploy for deploy/start/stop/restart.`;
    }
    case 404:
      return `Not found (404): ${resource ?? where}${msg ? ` — Coolify says: ${msg}` : ""}.`;
    case 422: {
      const details = validationDetails(body);
      return `Coolify validation failed (422) on ${where}: ${msg ?? "validation error"}${details ? ` — ${details}` : ""}.`;
    }
    case 429:
      return `Coolify rate limit hit (429) on ${where}: ${msg ?? "too many requests"}. Wait and retry.`;
    default:
      return `Coolify returned ${status} on ${where}: ${msg ?? "no details"}.`;
  }
}

export class CoolifyClient {
  private readonly apiBase: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: Pick<Config, "apiBase" | "token" | "timeoutMs">, fetchImpl: typeof fetch = fetch) {
    this.apiBase = config.apiBase;
    this.token = config.token;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  url(path: string, query?: Query): string {
    const u = new URL(this.apiBase + (path.startsWith("/") ? path : `/${path}`));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = this.url(path, opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      const reason =
        e.name === "TimeoutError" ? `timed out after ${this.timeoutMs} ms` : e.cause?.code ?? e.cause?.message ?? e.message;
      throw new CoolifyError(redact(`Cannot reach Coolify at ${this.apiBase} (${method} ${path}): ${reason}.`, this.token));
    }

    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      throw new CoolifyError(redact(mapHttpError(res.status, parsed, method, path, opts.resource), this.token), res.status);
    }
    return parsed as T;
  }

  get<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("GET", path, opts);
  }
  post<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("POST", path, opts);
  }
  patch<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("PATCH", path, opts);
  }
  delete<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("DELETE", path, opts);
  }
}
