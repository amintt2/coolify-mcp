import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CoolifyError, redact } from "./client.js";
import type { Config } from "./config.js";
import { Coolify, kindPath, type Application, type Database, type Service } from "./coolify.js";
import { planSetEnvs, viewEnv, type EnvInput, type RawEnv } from "./envs.js";
import { deploymentLogLines, splitLines, tail } from "./logs.js";
import type { ResourceKind } from "./resolve.js";

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): TextResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fail(message: string): TextResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

const resourceRef = z
  .string()
  .min(1)
  .describe("The resource: its uuid, its exact name, or a unique part of its name or domain (e.g. \"api\" or \"app.example.com\").");
const resourceType = z
  .enum(["application", "service"])
  .optional()
  .describe("Restrict lookup to applications or services. Omit to search both.");
const appRef = z
  .string()
  .min(1)
  .describe("Application uuid, exact name, or a unique part of its name or domain.");
const dryRun = z
  .boolean()
  .optional()
  .default(false)
  .describe("Report what would change without calling the mutating API. Allowed even in read-only mode.");

const envItem = z.object({
  key: z.string().min(1).describe("Variable name, must match ^[A-Za-z_][A-Za-z0-9_]*$."),
  value: z.string().describe("New value. Coolify trims leading/trailing whitespace."),
  is_build_time: z
    .boolean()
    .optional()
    .describe("Applications only: available at build time. Coolify defaults new keys to true."),
  is_runtime: z
    .boolean()
    .optional()
    .describe("Applications only (newer Coolify): available at runtime. Defaults to true for new keys."),
  is_preview: z
    .boolean()
    .optional()
    .describe("Applications only: target the preview-deployment copy of the variable instead of the main one."),
  is_literal: z.boolean().optional().describe("Treat the value literally (no $VAR interpolation)."),
  is_multiline: z.boolean().optional().describe("Value spans several lines (certificates, keys...)."),
});

function appSummary(a: Application, loc: { project?: string; environment?: string }) {
  return {
    name: a.name,
    uuid: a.uuid,
    fqdn: a.fqdn ?? null,
    status: a.status ?? null,
    git_repository: a.git_repository ?? null,
    git_branch: a.git_branch ?? null,
    build_pack: a.build_pack ?? null,
    project: loc.project ?? null,
    environment: loc.environment ?? null,
  };
}

const APP_DETAIL_FIELDS = [
  "description",
  "git_commit_sha",
  "docker_registry_image_name",
  "docker_registry_image_tag",
  "ports_exposes",
  "ports_mappings",
  "base_directory",
  "publish_directory",
  "dockerfile_location",
  "docker_compose_location",
  "install_command",
  "build_command",
  "start_command",
  "pre_deployment_command",
  "post_deployment_command",
  "health_check_enabled",
  "health_check_path",
  "health_check_port",
  "limits_memory",
  "limits_cpus",
  "redirect",
  "last_online_at",
  "created_at",
  "updated_at",
] as const;

function deploymentSummary(d: Record<string, unknown>) {
  const pick = [
    "deployment_uuid",
    "status",
    "application_name",
    "application_id",
    "commit",
    "commit_message",
    "force_rebuild",
    "restart_only",
    "rollback",
    "is_webhook",
    "is_api",
    "pull_request_id",
    "server_name",
    "deployment_url",
    "created_at",
    "updated_at",
    "finished_at",
  ];
  const out: Record<string, unknown> = {};
  for (const k of pick) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

function applyHint(kind: ResourceKind): string {
  return kind === "application"
    ? "Env changes are not live until the app restarts: use restart_application for runtime-only variables, or deploy (rebuild) when a build-time variable changed (new keys are build-time by default)."
    : "Env changes are not live until the service restarts: use restart_service.";
}

export function registerTools(server: McpServer, config: Config, coolify: Coolify): void {
  const guard = (fn: () => Promise<TextResult>, opts: { mutating?: boolean; dryRun?: boolean } = {}) =>
    (async (): Promise<TextResult> => {
      if (config.configError) return fail(config.configError);
      if (opts.mutating && config.readOnly && !opts.dryRun) {
        return fail("Refused: this Coolify MCP server runs with COOLIFY_READ_ONLY=1, so mutating tools are disabled. (dry_run: true is still allowed where supported.)");
      }
      try {
        return await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(redact(err instanceof CoolifyError ? message : `Unexpected error: ${message}`, config.token));
      }
    })();

  // ---------------------------------------------------------------- discovery

  server.registerTool(
    "get_version",
    {
      title: "Coolify version and health",
      description:
        "Check connectivity: returns the Coolify version, the health endpoint result, the API base URL in use and whether this MCP server is read-only / allows revealing secrets. Call this first when other tools fail.",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      guard(async () => {
        const [version, health] = await Promise.allSettled([
          coolify.client.get<string>("/version"),
          coolify.client.get<string>("/health"),
        ]);
        return ok({
          api_base: config.apiBase,
          version: version.status === "fulfilled" ? version.value : undefined,
          version_error: version.status === "rejected" ? (version.reason as Error).message : undefined,
          health: health.status === "fulfilled" ? health.value : `error: ${(health.reason as Error).message}`,
          read_only: config.readOnly,
          allow_reveal: config.allowReveal,
        });
      }),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List Coolify projects with their environments (e.g. production, staging).",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      guard(async () => {
        const projects = await coolify.listProjects();
        const idx = await coolify.environmentIndex().catch(() => new Map());
        const envsByProject = new Map<string, string[]>();
        for (const loc of idx.values()) {
          const list = envsByProject.get(loc.project_uuid) ?? [];
          list.push(loc.environment);
          envsByProject.set(loc.project_uuid, list);
        }
        return ok(
          projects.map((p) => ({
            name: p.name,
            uuid: p.uuid,
            description: p.description ?? null,
            environments: envsByProject.get(p.uuid) ?? [],
          })),
        );
      }),
  );

  server.registerTool(
    "list_servers",
    {
      title: "List servers",
      description: "List servers attached to Coolify with IP, reachability and proxy type.",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      guard(async () => {
        const servers = await coolify.client.get<Array<Record<string, any>>>("/servers");
        return ok(
          servers.map((s) => ({
            name: s.name,
            uuid: s.uuid,
            description: s.description ?? null,
            ip: s.ip,
            port: s.port,
            user: s.user,
            proxy_type: s.proxy_type ?? s.proxy?.type ?? null,
            is_reachable: s.settings?.is_reachable ?? s.is_reachable ?? null,
            is_usable: s.settings?.is_usable ?? s.is_usable ?? null,
          })),
        );
      }),
  );

  server.registerTool(
    "list_applications",
    {
      title: "List applications",
      description:
        "List applications with name, uuid, domain(s) (fqdn), status (e.g. running:healthy, exited), git repo/branch, build pack, project and environment. Use `filter` to narrow by name/domain substring.",
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring matched against name and fqdn."),
      },
      annotations: READ,
    },
    ({ filter }) =>
      guard(async () => {
        let apps = await coolify.listApplications();
        if (filter) {
          const f = filter.toLowerCase();
          apps = apps.filter((a) => a.name?.toLowerCase().includes(f) || (a.fqdn ?? "").toLowerCase().includes(f));
        }
        const idx = await coolify.environmentIndex().catch(() => new Map());
        return ok(apps.map((a) => appSummary(a, idx.get(a.environment_id as number) ?? {})));
      }),
  );

  server.registerTool(
    "get_application",
    {
      title: "Get application",
      description:
        "Get one application's details (domains, status, git, build/start commands, ports, health check, limits, project/environment). Accepts a uuid, exact name, or a unique name/domain substring; errors with the candidates when ambiguous. Secrets (webhook secrets, basic-auth password, compose files) are never returned.",
      inputSchema: { application: appRef },
      annotations: READ,
    },
    ({ application }) =>
      guard(async () => {
        const app = await coolify.resolveApplication(application);
        const loc = await coolify.locate(app.environment_id);
        const detail: Record<string, unknown> = appSummary(app, loc);
        for (const k of APP_DETAIL_FIELDS) if (app[k] !== undefined) detail[k] = app[k];
        return ok(detail);
      }),
  );

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description: "List one-click / docker-compose services (name, uuid, type, status, project/environment).",
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring matched against name."),
      },
      annotations: READ,
    },
    ({ filter }) =>
      guard(async () => {
        let services = await coolify.listServices();
        if (filter) services = services.filter((s) => s.name?.toLowerCase().includes(filter.toLowerCase()));
        const idx = await coolify.environmentIndex().catch(() => new Map());
        return ok(
          services.map((s: Service) => {
            const loc = idx.get(s.environment_id as number) ?? {};
            return {
              name: s.name,
              uuid: s.uuid,
              service_type: s.service_type ?? null,
              status: s.status ?? null,
              description: s.description ?? null,
              project: loc.project ?? null,
              environment: loc.environment ?? null,
            };
          }),
        );
      }),
  );

  server.registerTool(
    "list_databases",
    {
      title: "List databases",
      description:
        "List standalone databases (name, uuid, type, status, public exposure, project/environment). Connection URLs and passwords are never returned.",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      guard(async () => {
        const dbs = await coolify.listDatabases();
        const idx = await coolify.environmentIndex().catch(() => new Map());
        return ok(
          dbs.map((d: Database) => {
            const loc = idx.get(d.environment_id as number) ?? {};
            return {
              name: d.name,
              uuid: d.uuid,
              type: d.database_type ?? d.type ?? null,
              status: d.status ?? null,
              is_public: d.is_public ?? null,
              public_port: d.public_port ?? null,
              project: loc.project ?? null,
              environment: loc.environment ?? null,
            };
          }),
        );
      }),
  );

  // ---------------------------------------------------------------- env vars

  server.registerTool(
    "list_envs",
    {
      title: "List environment variables",
      description:
        "List the environment variables of an application or service: key, uuid and flags (is_build_time, is_runtime, is_preview, is_literal, is_multiline, is_shown_once). Values are MASKED (short prefix + length, or \"(empty)\") so secrets stay out of the conversation. `reveal: true` returns plaintext only if the server was started with COOLIFY_ALLOW_REVEAL=1 — avoid it unless the user explicitly needs a value.",
      inputSchema: {
        resource: resourceRef,
        resource_type: resourceType,
        key_filter: z.string().optional().describe("Only keys containing this substring (case-insensitive)."),
        reveal: z.boolean().optional().default(false).describe("Return plaintext values (requires COOLIFY_ALLOW_REVEAL=1)."),
      },
      annotations: READ,
    },
    ({ resource, resource_type, key_filter, reveal }) =>
      guard(async () => {
        if (reveal && !config.allowReveal) {
          return fail("Refused: revealing env values is disabled. Start the MCP server with COOLIFY_ALLOW_REVEAL=1 to allow it, or use the masked listing.");
        }
        const { kind, item } = await coolify.resolveResource(resource, resource_type);
        let envs = await coolify.listEnvs(kind, item.uuid, `"${item.name}"`);
        if (key_filter) envs = envs.filter((e) => e.key.toLowerCase().includes(key_filter.toLowerCase()));
        const views = envs.map((e) => viewEnv(e, Boolean(reveal)));
        const hidden = envs.some((e) => !Object.prototype.hasOwnProperty.call(e, "value"));
        return ok({
          resource: { type: kind, name: item.name, uuid: item.uuid },
          count: views.length,
          values: reveal ? "plaintext (reveal)" : "masked",
          note: hidden
            ? "Coolify did not return values: the token lacks the read:sensitive permission (or the user is not a team admin). set_envs still works but cannot tell 'unchanged' from 'updated'."
            : undefined,
          envs: views,
        });
      }),
  );

  server.registerTool(
    "set_envs",
    {
      title: "Create or update environment variables",
      description:
        "Upsert one or many environment variables on an application or service in a single call: existing keys are updated, missing keys created, identical ones left alone. Returns per key created / updated / unchanged plus which fields changed — values are never echoed. Flags you omit keep their current value on update. For applications, the main and preview copies of a key are separate (use is_preview). Use dry_run to preview. Changes only take effect after restart_application / restart_service, or deploy for build-time variables.",
      inputSchema: {
        resource: resourceRef,
        resource_type: resourceType,
        envs: z.array(envItem).min(1).max(200).describe("Variables to upsert."),
        dry_run: dryRun,
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ resource, resource_type, envs, dry_run }) =>
      guard(
        async () => {
          const { kind, item } = await coolify.resolveResource(resource, resource_type);
          const existing = await coolify.listEnvs(kind, item.uuid, `"${item.name}"`);
          const plan = planSetEnvs(existing, envs as EnvInput[], kind);
          const summary = {
            created: plan.entries.filter((e) => e.status === "created").length,
            updated: plan.entries.filter((e) => e.status === "updated").length,
            unchanged: plan.entries.filter((e) => e.status === "unchanged").length,
          };
          const base = { resource: { type: kind, name: item.name, uuid: item.uuid } };
          if (dry_run) {
            return ok({ ...base, dry_run: true, message: "Dry run: nothing was sent to Coolify.", summary, results: plan.entries });
          }
          if (plan.payload.length === 0) {
            return ok({ ...base, dry_run: false, message: "Nothing to change: every variable already has this value and flags.", summary, results: plan.entries });
          }
          await coolify.client.patch<RawEnv[]>(`${kindPath(kind, item.uuid)}/envs/bulk`, {
            body: { data: plan.payload },
            resource: `${kind} "${item.name}" (uuid ${item.uuid})`,
          });
          return ok({ ...base, dry_run: false, summary, results: plan.entries, next_step: applyHint(kind) });
        },
        { mutating: true, dryRun: dry_run },
      ),
  );

  server.registerTool(
    "delete_env",
    {
      title: "Delete an environment variable",
      description:
        "Delete one environment variable from an application or service, by key. For applications, is_preview selects the preview copy (default: the main one). Use dry_run to check first. Takes effect after a restart/redeploy.",
      inputSchema: {
        resource: resourceRef,
        resource_type: resourceType,
        key: z.string().min(1).describe("Variable name to delete."),
        is_preview: z.boolean().optional().default(false).describe("Applications only: delete the preview copy of the key."),
        dry_run: dryRun,
      },
      annotations: { ...DESTRUCTIVE, idempotentHint: false },
    },
    ({ resource, resource_type, key, is_preview, dry_run }) =>
      guard(
        async () => {
          const { kind, item } = await coolify.resolveResource(resource, resource_type);
          const envs = await coolify.listEnvs(kind, item.uuid, `"${item.name}"`);
          const match = envs.find((e) => e.key === key && (kind === "service" || Boolean(e.is_preview) === Boolean(is_preview)));
          if (!match) {
            const keys = [...new Set(envs.map((e) => e.key))].sort();
            const other = envs.find((e) => e.key === key);
            const hint = other ? ` (a ${other.is_preview ? "preview" : "main"} copy exists — set is_preview: ${Boolean(other.is_preview)})` : "";
            throw new CoolifyError(
              `Key "${key}" not found on ${kind} "${item.name}"${hint}. Existing keys: ${keys.join(", ") || "(none)"}.`,
              404,
            );
          }
          const base = { resource: { type: kind, name: item.name, uuid: item.uuid }, key, env_uuid: match.uuid, is_preview: Boolean(match.is_preview) };
          if (dry_run) return ok({ ...base, dry_run: true, message: "Dry run: would delete this variable; nothing was sent." });
          await coolify.client.delete(`${kindPath(kind, item.uuid)}/envs/${encodeURIComponent(match.uuid)}`, {
            resource: `env "${key}" on ${kind} "${item.name}"`,
          });
          return ok({ ...base, dry_run: false, deleted: true, next_step: applyHint(kind) });
        },
        { mutating: true, dryRun: dry_run },
      ),
  );

  // ---------------------------------------------------------------- lifecycle

  server.registerTool(
    "deploy",
    {
      title: "Deploy",
      description:
        "Queue a (re)deployment — rebuilds and restarts. Target either `resource` (application/service uuid or name; comma-separate several) or `tag` (every resource with that Coolify tag). `force: true` rebuilds without cache. Returns deployment uuids; follow progress with get_deployment. Needs the token's deploy permission.",
      inputSchema: {
        resource: z.string().optional().describe("Application or service uuid/name; several separated by commas."),
        tag: z.string().optional().describe("Coolify tag name(s), comma separated. Mutually exclusive with resource."),
        force: z.boolean().optional().default(false).describe("Force rebuild without Docker cache."),
      },
      annotations: WRITE,
    },
    ({ resource, tag, force }) =>
      guard(
        async () => {
          if (Boolean(resource) === Boolean(tag)) return fail("Pass exactly one of `resource` or `tag`.");
          const query: Record<string, string | boolean> = {};
          const targets: Array<{ type: string; name: string; uuid: string }> = [];
          if (resource) {
            for (const ref of resource.split(",").map((r) => r.trim()).filter(Boolean)) {
              const { kind, item } = await coolify.resolveResource(ref);
              targets.push({ type: kind, name: item.name, uuid: item.uuid });
            }
            query.uuid = targets.map((t) => t.uuid).join(",");
          } else {
            query.tag = tag as string;
          }
          if (force) query.force = true;
          const res = await coolify.client.post<Record<string, unknown>>("/deploy", { query });
          return ok({ targets: targets.length ? targets : undefined, tag, force, response: res, next_step: "Follow with get_deployment(deployment_uuid)." });
        },
        { mutating: true },
      ),
  );

  const appAction = (
    name: string,
    title: string,
    description: string,
    path: string,
    extra: Record<string, z.ZodTypeAny>,
    toQuery: (args: Record<string, unknown>) => Record<string, boolean | undefined>,
    annotations: typeof WRITE | typeof DESTRUCTIVE,
  ) =>
    server.registerTool(
      name,
      { title, description, inputSchema: { application: appRef, ...extra }, annotations },
      (args: Record<string, unknown>) =>
        guard(
          async () => {
            const app = await coolify.resolveApplication(args.application as string);
            const res = await coolify.client.post(`/applications/${encodeURIComponent(app.uuid)}/${path}`, {
              query: toQuery(args),
              resource: `application "${app.name}" (uuid ${app.uuid})`,
            });
            return ok({ application: { name: app.name, uuid: app.uuid }, response: res });
          },
          { mutating: true },
        ),
    );

  appAction(
    "restart_application",
    "Restart application",
    "Restart an application's containers without rebuilding (picks up runtime env var changes; build-time changes need deploy). Returns a deployment uuid to follow with get_deployment.",
    "restart",
    {},
    () => ({}),
    WRITE,
  );

  appAction(
    "start_application",
    "Start application",
    "Start (deploy) a stopped application. `force` rebuilds without cache; `instant_deploy` skips the queue.",
    "start",
    {
      force: z.boolean().optional().describe("Force rebuild without cache."),
      instant_deploy: z.boolean().optional().describe("Skip the deployment queue."),
    },
    (a) => ({ force: a.force as boolean | undefined, instant_deploy: a.instant_deploy as boolean | undefined }),
    WRITE,
  );

  appAction(
    "stop_application",
    "Stop application",
    "Stop an application's containers (the site goes down until start_application or deploy). `docker_cleanup` (Coolify default true) prunes networks/volumes afterwards.",
    "stop",
    { docker_cleanup: z.boolean().optional().describe("Prune unused Docker networks/volumes after stopping (Coolify default: true).") },
    (a) => ({ docker_cleanup: a.docker_cleanup as boolean | undefined }),
    DESTRUCTIVE,
  );

  server.registerTool(
    "restart_service",
    {
      title: "Restart service",
      description: "Restart a service (all its containers), e.g. after changing its env vars. `latest: true` pulls the latest images first.",
      inputSchema: {
        service: z.string().min(1).describe("Service uuid, exact name, or unique name substring."),
        latest: z.boolean().optional().describe("Pull latest images before restarting."),
      },
      annotations: WRITE,
    },
    ({ service, latest }) =>
      guard(
        async () => {
          const svc = await coolify.resolveService(service);
          const res = await coolify.client.post(`/services/${encodeURIComponent(svc.uuid)}/restart`, {
            query: { latest },
            resource: `service "${svc.name}" (uuid ${svc.uuid})`,
          });
          return ok({ service: { name: svc.name, uuid: svc.uuid }, response: res });
        },
        { mutating: true },
      ),
  );

  server.registerTool(
    "list_deployments",
    {
      title: "List deployments",
      description:
        "With `application`: that app's most recent deployments (newest first, status/commit/timestamps). Without it: deployments currently queued or in progress across all servers.",
      inputSchema: {
        application: appRef.optional(),
        limit: z.number().int().min(1).max(100).optional().default(10).describe("How many recent deployments (per application)."),
      },
      annotations: READ,
    },
    ({ application, limit }) =>
      guard(async () => {
        if (!application) {
          const running = await coolify.client.get<Array<Record<string, unknown>>>("/deployments");
          return ok({ scope: "queued or in progress", count: running.length, deployments: running.map(deploymentSummary) });
        }
        const app = await coolify.resolveApplication(application);
        const res = await coolify.client.get<{ count?: number; deployments?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
          `/deployments/applications/${encodeURIComponent(app.uuid)}`,
          { query: { take: limit, skip: 0 }, resource: `application "${app.name}" (uuid ${app.uuid})` },
        );
        const list = Array.isArray(res) ? res : res.deployments ?? [];
        return ok({
          application: { name: app.name, uuid: app.uuid },
          total: Array.isArray(res) ? undefined : res.count,
          deployments: list.slice(0, limit).map(deploymentSummary),
        });
      }),
  );

  server.registerTool(
    "get_deployment",
    {
      title: "Get deployment",
      description:
        "Status of one deployment plus the last `lines` lines of its build/deploy log (default 100). Log output requires the token's read:sensitive permission.",
      inputSchema: {
        deployment_uuid: z.string().min(1).describe("Deployment uuid (from deploy, restart_application or list_deployments)."),
        lines: z.number().int().min(1).max(2000).optional().default(100).describe("How many trailing log lines to return."),
      },
      annotations: READ,
    },
    ({ deployment_uuid, lines }) =>
      guard(async () => {
        const d = await coolify.client.get<Record<string, unknown>>(`/deployments/${encodeURIComponent(deployment_uuid)}`, {
          resource: `deployment ${deployment_uuid}`,
        });
        const summary = deploymentSummary(d);
        if (!("logs" in d)) {
          return ok({ ...summary, logs: null, logs_note: "Coolify did not return logs: the token lacks the read:sensitive permission." });
        }
        const t = tail(deploymentLogLines(d.logs), lines);
        return ok({ ...summary, log_lines_total: t.total, log_lines_shown: t.shown, logs: t.text });
      }),
  );

  server.registerTool(
    "get_application_logs",
    {
      title: "Get application logs",
      description:
        "Last `lines` lines (default 100) of a running application's container logs. Fails with a clear message if the app is not running.",
      inputSchema: {
        application: appRef,
        lines: z.number().int().min(1).max(5000).optional().default(100).describe("Trailing lines to return."),
        show_timestamps: z.boolean().optional().describe("Prefix lines with Docker timestamps."),
      },
      annotations: READ,
    },
    ({ application, lines, show_timestamps }) =>
      guard(async () => {
        const app = await coolify.resolveApplication(application);
        const res = await coolify.client.get<{ logs?: string }>(`/applications/${encodeURIComponent(app.uuid)}/logs`, {
          query: { lines, show_timestamps },
          resource: `application "${app.name}" (uuid ${app.uuid})`,
        });
        const t = tail(splitLines(res?.logs ?? ""), lines);
        return ok({ application: { name: app.name, uuid: app.uuid }, lines_shown: t.shown, logs: t.text });
      }),
  );
}
