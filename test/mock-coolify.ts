import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Small in-process imitation of the Coolify v4 REST API (only the endpoints this
 * server uses), following the behaviour of coollabsio/coolify's API controllers.
 */

export interface MockEnv {
  id: number;
  uuid: string;
  key: string;
  value: string | null;
  is_preview: boolean;
  is_literal: boolean;
  is_multiline: boolean;
  is_shown_once: boolean;
  is_buildtime: boolean;
  is_runtime: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  authorization?: string;
}

export interface MockOptions {
  token?: string;
  /** Token has read:sensitive (values + logs returned). Default true. */
  sensitive?: boolean;
}

let seq = 1000;
const uid = (p: string) => `${p}${(seq++).toString(36)}xk2m9q`;

export class MockCoolify {
  token: string;
  sensitive: boolean;
  requests: RecordedRequest[] = [];
  /** Next request (any route) answers with this instead. */
  failNext?: { status: number; body: unknown };
  server?: http.Server;
  url = "";

  projects = [
    { id: 1, uuid: "proj1uuid", name: "Acme", description: null, environments: [{ id: 10, uuid: "env10", name: "production" }, { id: 11, uuid: "env11", name: "staging" }] },
  ];
  servers = [{ uuid: "srv1uuid", name: "localhost", ip: "10.0.0.1", port: 22, user: "root", description: null, proxy_type: "traefik", settings: { is_reachable: true, is_usable: true } }];
  applications: any[] = [
    { id: 1, uuid: "app1uuid", name: "acme-web", fqdn: "https://acme.example.org,https://www.acme.example.org", status: "running:healthy", git_repository: "acme/acme", git_branch: "main", build_pack: "nixpacks", environment_id: 10, manual_webhook_secret_github: "whsec_should_not_leak", http_basic_auth_password: "pw_should_not_leak" },
    { id: 2, uuid: "app2uuid", name: "acme-worker", fqdn: null, status: "running:healthy", git_repository: "acme/acme", git_branch: "main", build_pack: "dockerfile", environment_id: 10 },
    { id: 3, uuid: "app3uuid", name: "docs", fqdn: "https://docs.example.com", status: "exited", git_repository: "acme/docs", git_branch: "main", build_pack: "static", environment_id: 11 },
  ];
  services: any[] = [{ id: 7, uuid: "svc1uuid", name: "plausible", service_type: "plausible", environment_id: 10 }];
  databases: any[] = [{ uuid: "db1uuid", name: "pg", database_type: "standalone-postgresql", status: "running:healthy", environment_id: 10, is_public: false, internal_db_url: "postgres://u:secret@pg:5432/db", postgres_password: "secret" }];
  envs = new Map<string, MockEnv[]>();
  deployments: any[] = [];

  constructor(opts: MockOptions = {}) {
    this.token = opts.token ?? "1|mocktoken_abcdefghijklmnop";
    this.sensitive = opts.sensitive ?? true;
    this.envs.set("application:app1uuid", [
      this.mkEnv("DATABASE_URL", "postgres://user:hunter2@db:5432/app"),
      this.mkEnv("NODE_ENV", "production", { is_buildtime: true }),
      this.mkEnv("EMPTY_ONE", null),
      this.mkEnv("PEM", "-----BEGIN KEY-----\nabc\n-----END KEY-----", { is_multiline: true, is_literal: true }),
      this.mkEnv("NODE_ENV", "preview", { is_preview: true }),
    ]);
    this.envs.set("application:app2uuid", []);
    this.envs.set("service:svc1uuid", [this.mkEnv("SERVICE_FQDN_PLAUSIBLE", "https://stats.example.com"), this.mkEnv("SECRET_KEY_BASE", "sk_live_1234567890")]);
    this.deployments.push({
      id: 1,
      deployment_uuid: "dep1uuid",
      application_id: "1",
      application_name: "acme-web",
      status: "finished",
      commit: "abc123",
      commit_message: "fix things",
      force_rebuild: false,
      server_name: "localhost",
      created_at: "2026-09-20T10:00:00Z",
      updated_at: "2026-09-20T10:03:00Z",
      logs: JSON.stringify([
        { command: "docker build", output: "Step 1/3\nStep 2/3", type: "stdout", hidden: false, timestamp: "t1", batch: 1, order: 1 },
        { command: "secret", output: "internal hidden line", type: "stdout", hidden: true, timestamp: "t2", batch: 1, order: 2 },
        { command: null, output: "Step 3/3\nDeployment finished.", type: "stdout", hidden: false, timestamp: "t3", batch: 1, order: 3 },
        { command: null, output: "warning: something", type: "stderr", hidden: false, timestamp: "t4", batch: 1, order: 4 },
      ]),
    });
  }

  mkEnv(key: string, value: string | null, flags: Partial<MockEnv> = {}): MockEnv {
    return {
      id: seq++,
      uuid: uid("env"),
      key,
      value,
      is_preview: false,
      is_literal: false,
      is_multiline: false,
      is_shown_once: false,
      is_buildtime: true,
      is_runtime: true,
      ...flags,
    };
  }

  envsOf(kind: string, uuid: string): MockEnv[] | undefined {
    return this.envs.get(`${kind}:${uuid}`);
  }

  private serializeEnv(e: MockEnv) {
    const out: Record<string, unknown> = { ...e };
    delete out.id;
    if (!this.sensitive || e.is_shown_once) {
      delete out.value;
    } else {
      out.real_value = e.value;
    }
    return out;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server!.close(() => r()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      let body: any = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const rec: RecordedRequest = {
        method: req.method ?? "GET",
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        body,
        authorization: req.headers.authorization,
      };
      this.requests.push(rec);
      const send = (status: number, payload: unknown, text = false) => {
        res.writeHead(status, { "Content-Type": text ? "text/html" : "application/json" });
        res.end(text ? String(payload) : JSON.stringify(payload));
      };
      if (!u.pathname.startsWith("/api/v1")) return send(404, { message: "Not found." });
      const path = u.pathname.slice("/api/v1".length);

      if (path === "/health") return send(200, "OK", true);
      if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { message: "Unauthenticated." });
      if (this.failNext) {
        const f = this.failNext;
        this.failNext = undefined;
        return send(f.status, f.body);
      }
      try {
        this.route(rec.method, path, rec, send);
      } catch (err) {
        send(500, { message: String(err) });
      }
    });
  }

  private route(method: string, path: string, rec: RecordedRequest, send: (s: number, p: unknown, t?: boolean) => void) {
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/version") return send(200, "4.0.0-beta.420.6", true);
    if (method === "GET" && path === "/projects") return send(200, this.projects.map(({ environments, id, ...p }) => p));
    if (method === "GET" && (m = path.match(/^\/projects\/([^/]+)$/))) {
      const p = this.projects.find((x) => x.uuid === m![1]);
      return p ? send(200, p) : send(404, { message: "Project not found." });
    }
    if (method === "GET" && path === "/servers") return send(200, this.servers);
    if (method === "GET" && path === "/applications") return send(200, this.applications);
    if (method === "GET" && path === "/services") return send(200, this.services);
    if (method === "GET" && path === "/databases") return send(200, this.databases);

    if ((m = path.match(/^\/(applications|services)\/([^/]+)\/envs(\/bulk|\/[^/]+)?$/))) {
      const kind = m[1] === "applications" ? "application" : "service";
      const list = this.envsOf(kind, m[2]);
      if (!list) return send(404, { message: kind === "application" ? "Application not found" : "Service not found." });
      if (method === "GET" && !m[3]) return send(200, list.map((e) => this.serializeEnv(e)));
      if (method === "PATCH" && m[3] === "/bulk") return this.bulk(kind, list, rec.body, send);
      if (method === "DELETE" && m[3]) {
        const idx = list.findIndex((e) => e.uuid === m![3].slice(1));
        if (idx < 0) return send(404, { message: "Environment variable not found." });
        list.splice(idx, 1);
        return send(200, { message: "Environment variable deleted." });
      }
    }

    if (method === "POST" && path === "/deploy") {
      const uuids = (rec.query.uuid ?? "").split(",").filter(Boolean);
      if (!uuids.length && !rec.query.tag) return send(400, { message: "You must provide uuid or tag." });
      return send(200, {
        deployments: uuids.map((u) => ({ message: `Resource ${u} deployment queued.`, resource_uuid: u, deployment_uuid: `dep_${u}` })),
      });
    }
    if (method === "POST" && (m = path.match(/^\/applications\/([^/]+)\/(start|stop|restart)$/))) {
      if (!this.applications.find((a) => a.uuid === m![1])) return send(404, { message: "Application not found." });
      if (m[2] === "stop") return send(200, { message: "Application stopping request queued." });
      return send(200, { message: m[2] === "restart" ? "Restart request queued." : "Deployment request queued.", deployment_uuid: "dep_new" });
    }
    if (method === "POST" && (m = path.match(/^\/services\/([^/]+)\/restart$/))) {
      return send(200, { message: "Service restaring request queued." });
    }
    if (method === "GET" && path === "/deployments") {
      return send(200, this.deployments.filter((d) => ["queued", "in_progress"].includes(d.status)).map((d) => this.serializeDeployment(d)));
    }
    if (method === "GET" && (m = path.match(/^\/deployments\/applications\/([^/]+)$/))) {
      const app = this.applications.find((a) => a.uuid === m![1]);
      if (!app) return send(404, { message: "Application not found" });
      const list = this.deployments.filter((d) => d.application_id === String(app.id));
      return send(200, { count: list.length, deployments: list.slice(0, Number(rec.query.take ?? 10)).map((d) => this.serializeDeployment(d)) });
    }
    if (method === "GET" && (m = path.match(/^\/deployments\/([^/]+)$/))) {
      const d = this.deployments.find((x) => x.deployment_uuid === m![1]);
      return d ? send(200, this.serializeDeployment(d)) : send(404, { message: "Deployment not found." });
    }
    if (method === "GET" && (m = path.match(/^\/applications\/([^/]+)\/logs$/))) {
      const app = this.applications.find((a) => a.uuid === m![1]);
      if (!app) return send(404, { message: "Application not found." });
      if (!String(app.status).startsWith("running")) return send(400, { message: "Application is not running." });
      const n = Number(rec.query.lines ?? 100);
      const lines = Array.from({ length: 300 }, (_, i) => `log line ${i + 1}`);
      return send(200, { logs: lines.slice(-n).join("\n") + "\n" });
    }
    send(404, { message: "Route not found in mock." });
  }

  private serializeDeployment(d: any) {
    const out = { ...d };
    if (!this.sensitive) delete out.logs;
    return out;
  }

  /** Mirrors ApplicationsController::create_bulk_envs / ServicesController::create_bulk_envs. */
  private bulk(kind: string, list: MockEnv[], body: any, send: (s: number, p: unknown) => void) {
    if (!body?.data) return send(400, { message: "Bulk data is required." });
    const out: unknown[] = [];
    for (const item of body.data) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.key ?? "")) {
        return send(422, { message: "Validation failed.", errors: { key: ["The key field format is invalid."] } });
      }
      const value = item.value == null ? null : String(item.value).trim() || null;
      if (kind === "service") {
        let env = list.find((e) => e.key === item.key);
        if (!env) {
          env = this.mkEnv(item.key, value);
          list.push(env);
        }
        env.value = value;
        for (const f of ["is_literal", "is_multiline", "is_shown_once"] as const) if (f in item) env[f] = Boolean(item[f]);
        out.push(this.serializeEnv(env));
        continue;
      }
      const isPreview = Boolean(item.is_preview);
      let env = list.find((e) => e.key === item.key && e.is_preview === isPreview);
      if (env) {
        env.value = value;
        env.is_literal = Boolean(item.is_literal ?? false);
        env.is_multiline = Boolean(item.is_multiline);
        env.is_shown_once = Boolean(item.is_shown_once);
        if ("is_runtime" in item) env.is_runtime = Boolean(item.is_runtime);
        if ("is_buildtime" in item) env.is_buildtime = Boolean(item.is_buildtime);
      } else {
        env = this.mkEnv(item.key, value, {
          is_preview: isPreview,
          is_literal: Boolean(item.is_literal ?? false),
          is_multiline: Boolean(item.is_multiline ?? false),
          is_shown_once: Boolean(item.is_shown_once ?? false),
          is_runtime: item.is_runtime ?? true,
          is_buildtime: item.is_buildtime ?? true,
        });
        list.push(env);
      }
      out.push(this.serializeEnv(env));
    }
    send(201, out);
  }
}
