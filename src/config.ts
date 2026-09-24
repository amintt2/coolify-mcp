export interface Config {
  /** Instance URL as given, without trailing slash (e.g. https://coolify.example.com). */
  baseUrl: string;
  /** REST API base (`<baseUrl>/api/v1`). */
  apiBase: string;
  token: string;
  /** COOLIFY_READ_ONLY=1: every mutating tool is refused. */
  readOnly: boolean;
  /** COOLIFY_ALLOW_REVEAL=1: list_envs may return plaintext values when asked. */
  allowReveal: boolean;
  timeoutMs: number;
  /** Set when COOLIFY_URL / COOLIFY_TOKEN are missing; tools report it instead of calling the API. */
  configError?: string;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function envFlag(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

export function normalizeBaseUrl(raw: string): { baseUrl: string; apiBase: string } {
  let url = raw.trim().replace(/\/+$/, "");
  // Accept a URL that already points at the API.
  url = url.replace(/\/api\/v1$/i, "").replace(/\/api$/i, "");
  return { baseUrl: url, apiBase: `${url}/api/v1` };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.COOLIFY_URL ?? "";
  const token = (env.COOLIFY_TOKEN ?? "").trim();
  const problems: string[] = [];
  if (!rawUrl.trim()) problems.push("COOLIFY_URL is not set (e.g. https://coolify.example.com)");
  else if (!/^https?:\/\//i.test(rawUrl.trim())) problems.push("COOLIFY_URL must start with http:// or https://");
  if (!token) problems.push("COOLIFY_TOKEN is not set (create one in Coolify: Keys & Tokens -> API tokens)");

  const { baseUrl, apiBase } = rawUrl.trim() ? normalizeBaseUrl(rawUrl) : { baseUrl: "", apiBase: "" };
  const timeout = Number(env.COOLIFY_TIMEOUT_MS);
  return {
    baseUrl,
    apiBase,
    token,
    readOnly: envFlag(env.COOLIFY_READ_ONLY),
    allowReveal: envFlag(env.COOLIFY_ALLOW_REVEAL),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
    configError: problems.length ? `Coolify MCP is not configured: ${problems.join("; ")}.` : undefined,
  };
}
