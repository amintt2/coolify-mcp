import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mutatingRequests, setup, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("discovery", () => {
  it("lists applications with project/environment and no secrets", async () => {
    h = await setup();
    const r = await h.call("list_applications");
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.length, 3);
    const web = r.json.find((a: any) => a.name === "acme-web");
    assert.deepEqual([web.project, web.environment, web.git_branch, web.status], ["Acme", "production", "main", "running:healthy"]);
    assert.equal(r.json.find((a: any) => a.name === "docs").environment, "staging");
    assert.ok(!r.text.includes("should_not_leak"));
    assert.ok(h.mock.requests.every((q) => q.authorization === `Bearer ${h!.mock.token}`));
  });

  it("get_application resolves by name / domain and reports ambiguity", async () => {
    h = await setup();
    assert.equal((await h.call("get_application", { application: "acme.example.org" })).json.uuid, "app1uuid");
    assert.equal((await h.call("get_application", { application: "worker" })).json.uuid, "app2uuid");
    assert.equal((await h.call("get_application", { application: "app3uuid" })).json.name, "docs");
    const amb = await h.call("get_application", { application: "acme" });
    assert.equal(amb.isError, true);
    assert.match(amb.text, /ambiguous[\s\S]*app1uuid[\s\S]*app2uuid/);
    const none = await h.call("get_application", { application: "nothing-here" });
    assert.equal(none.isError, true);
    assert.match(none.text, /No application matches/);
    assert.ok(!(await h.call("get_application", { application: "app1uuid" })).text.includes("should_not_leak"));
  });

  it("lists services, databases (without credentials), servers, projects, version", async () => {
    h = await setup();
    assert.equal((await h.call("list_services")).json[0].name, "plausible");
    const dbs = await h.call("list_databases");
    assert.equal(dbs.json[0].type, "standalone-postgresql");
    assert.ok(!dbs.text.includes("secret"));
    assert.equal((await h.call("list_servers")).json[0].is_reachable, true);
    assert.deepEqual((await h.call("list_projects")).json[0].environments, ["production", "staging"]);
    const v = await h.call("get_version");
    assert.equal(v.json.version, "4.0.0-beta.420.6");
    assert.equal(v.json.health, "OK");
  });
});

describe("list_envs", () => {
  it("masks values by default", async () => {
    h = await setup();
    const r = await h.call("list_envs", { resource: "acme-web" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.values, "masked");
    assert.ok(!r.text.includes("hunter2"));
    assert.ok(!r.text.includes("BEGIN KEY"));
    const db = r.json.envs.find((e: any) => e.key === "DATABASE_URL");
    assert.equal(db.value, "post*** (35 chars)");
    assert.equal(r.json.envs.find((e: any) => e.key === "EMPTY_ONE").value, "(empty)");
    const pem = r.json.envs.find((e: any) => e.key === "PEM");
    assert.deepEqual([pem.is_multiline, pem.is_literal], [true, true]);
    assert.equal(r.json.envs.filter((e: any) => e.key === "NODE_ENV").length, 2, "main + preview copies");
  });

  it("works for services and filters keys", async () => {
    h = await setup();
    const r = await h.call("list_envs", { resource: "plausible", key_filter: "secret" });
    assert.equal(r.json.resource.type, "service");
    assert.deepEqual(r.json.envs.map((e: any) => e.key), ["SECRET_KEY_BASE"]);
    assert.ok(!r.text.includes("sk_live_1234567890"));
  });

  it("refuses reveal unless COOLIFY_ALLOW_REVEAL=1", async () => {
    h = await setup();
    const r = await h.call("list_envs", { resource: "acme-web", reveal: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /COOLIFY_ALLOW_REVEAL=1/);
    await h.close();
    h = await setup({ allowReveal: true });
    const ok = await h.call("list_envs", { resource: "acme-web", reveal: true });
    assert.equal(ok.json.envs.find((e: any) => e.key === "DATABASE_URL").value, "postgres://user:hunter2@db:5432/app");
  });

  it("explains when the token cannot read values", async () => {
    h = await setup({ sensitive: false });
    const r = await h.call("list_envs", { resource: "app1uuid" });
    assert.match(r.json.note, /read:sensitive/);
  });
});

describe("set_envs", () => {
  it("upserts in one bulk call and reports created/updated/unchanged without values", async () => {
    h = await setup();
    const r = await h.call("set_envs", {
      resource: "acme-web",
      envs: [
        { key: "NODE_ENV", value: "production" },
        { key: "DATABASE_URL", value: "postgres://new-secret-value" },
        { key: "NEW_KEY", value: "brand-new-secret", is_build_time: false },
        { key: "PEM", value: "-----BEGIN KEY-----\nxyz\n-----END KEY-----" },
      ],
    });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.summary, { created: 1, updated: 2, unchanged: 1 });
    assert.deepEqual(
      Object.fromEntries(r.json.results.map((e: any) => [e.key, e.status])),
      { NODE_ENV: "unchanged", DATABASE_URL: "updated", NEW_KEY: "created", PEM: "updated" },
    );
    assert.ok(!r.text.includes("new-secret-value") && !r.text.includes("brand-new-secret") && !r.text.includes("xyz"));
    assert.match(r.json.next_step, /restart_application|deploy/);

    const writes = mutatingRequests(h.mock);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PATCH");
    assert.equal(writes[0].path, "/api/v1/applications/app1uuid/envs/bulk");
    assert.deepEqual(writes[0].body.data.map((d: any) => d.key), ["DATABASE_URL", "NEW_KEY", "PEM"]);

    const envs = h.mock.envsOf("application", "app1uuid")!;
    const pem = envs.find((e) => e.key === "PEM")!;
    assert.deepEqual([pem.is_multiline, pem.is_literal], [true, true], "flags survive the bulk update");
    assert.equal(envs.find((e) => e.key === "NEW_KEY")!.is_buildtime, false);
    assert.equal(envs.find((e) => e.key === "NODE_ENV" && e.is_preview)!.value, "preview", "preview copy untouched");

    const again = await h.call("set_envs", { resource: "acme-web", envs: [{ key: "NEW_KEY", value: "brand-new-secret" }] });
    assert.equal(again.json.results[0].status, "unchanged");
    assert.equal(mutatingRequests(h.mock).length, 1, "no request when nothing changes");
  });

  it("targets preview copies separately", async () => {
    h = await setup();
    const r = await h.call("set_envs", { resource: "app1uuid", envs: [{ key: "NODE_ENV", value: "preview-2", is_preview: true }] });
    assert.equal(r.json.results[0].status, "updated");
    const envs = h.mock.envsOf("application", "app1uuid")!;
    assert.equal(envs.find((e) => e.key === "NODE_ENV" && e.is_preview)!.value, "preview-2");
    assert.equal(envs.find((e) => e.key === "NODE_ENV" && !e.is_preview)!.value, "production");
  });

  it("dry_run reports without writing", async () => {
    h = await setup();
    const r = await h.call("set_envs", { resource: "acme-web", envs: [{ key: "X_NEW", value: "1" }, { key: "NODE_ENV", value: "dev" }], dry_run: true });
    assert.equal(r.json.dry_run, true);
    assert.deepEqual(r.json.summary, { created: 1, updated: 1, unchanged: 0 });
    assert.equal(mutatingRequests(h.mock).length, 0);
  });

  it("validates keys before calling the API", async () => {
    h = await setup();
    const r = await h.call("set_envs", { resource: "acme-web", envs: [{ key: "BAD-KEY", value: "x" }] });
    assert.equal(r.isError, true);
    assert.match(r.text, /Invalid key "BAD-KEY"/);
    assert.equal(mutatingRequests(h.mock).length, 0);
  });

  it("upserts service envs", async () => {
    h = await setup();
    const r = await h.call("set_envs", { resource: "plausible", resource_type: "service", envs: [{ key: "SECRET_KEY_BASE", value: "rotated" }, { key: "DISABLE_REGISTRATION", value: "true" }] });
    assert.deepEqual(r.json.summary, { created: 1, updated: 1, unchanged: 0 });
    assert.equal(mutatingRequests(h.mock)[0].path, "/api/v1/services/svc1uuid/envs/bulk");
    assert.match(r.json.next_step, /restart_service/);
  });

  it("cannot claim 'unchanged' when Coolify hides values", async () => {
    h = await setup({ sensitive: false });
    const r = await h.call("set_envs", { resource: "acme-web", envs: [{ key: "NODE_ENV", value: "production" }] });
    assert.equal(r.json.results[0].status, "updated");
    assert.match(r.json.results[0].changes[0], /not comparable/);
  });
});

describe("delete_env", () => {
  it("deletes by key, supports dry_run, errors with the key list", async () => {
    h = await setup();
    const dry = await h.call("delete_env", { resource: "acme-web", key: "PEM", dry_run: true });
    assert.equal(dry.json.dry_run, true);
    assert.equal(mutatingRequests(h.mock).length, 0);

    const r = await h.call("delete_env", { resource: "acme-web", key: "PEM" });
    assert.equal(r.json.deleted, true);
    const del = mutatingRequests(h.mock)[0];
    assert.equal(del.method, "DELETE");
    assert.match(del.path, /^\/api\/v1\/applications\/app1uuid\/envs\/env/);
    assert.ok(!h.mock.envsOf("application", "app1uuid")!.some((e) => e.key === "PEM"));

    const missing = await h.call("delete_env", { resource: "acme-web", key: "NOPE" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Key "NOPE" not found[\s\S]*DATABASE_URL/);
    assert.ok(!missing.text.includes("hunter2"));
  });
});

describe("read-only mode", () => {
  it("refuses every mutating tool but allows reads and dry runs", async () => {
    h = await setup({ readOnly: true });
    const calls: Array<[string, Record<string, unknown>]> = [
      ["set_envs", { resource: "acme-web", envs: [{ key: "A", value: "b" }] }],
      ["delete_env", { resource: "acme-web", key: "PEM" }],
      ["deploy", { resource: "acme-web" }],
      ["restart_application", { application: "acme-web" }],
      ["start_application", { application: "acme-web" }],
      ["stop_application", { application: "acme-web" }],
      ["restart_service", { service: "plausible" }],
    ];
    for (const [name, args] of calls) {
      const r = await h.call(name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, /COOLIFY_READ_ONLY=1/, name);
    }
    assert.equal(mutatingRequests(h.mock).length, 0);
    assert.equal((await h.call("list_envs", { resource: "acme-web" })).isError, false);
    const dry = await h.call("set_envs", { resource: "acme-web", envs: [{ key: "A", value: "b" }], dry_run: true });
    assert.equal(dry.isError, false);
    assert.equal(mutatingRequests(h.mock).length, 0);
  });
});

describe("lifecycle", () => {
  it("deploys by name with force, and by tag", async () => {
    h = await setup();
    const r = await h.call("deploy", { resource: "acme-web, plausible", force: true });
    assert.equal(r.isError, false, r.text);
    const req = mutatingRequests(h.mock)[0];
    assert.equal(req.path, "/api/v1/deploy");
    assert.deepEqual(req.query, { uuid: "app1uuid,svc1uuid", force: "true" });
    assert.equal(r.json.response.deployments.length, 2);
    await h.call("deploy", { tag: "prod" });
    assert.deepEqual(mutatingRequests(h.mock)[1].query, { tag: "prod" });
    assert.equal((await h.call("deploy", {})).isError, true);
  });

  it("restart / start / stop hit the right endpoints", async () => {
    h = await setup();
    assert.equal((await h.call("restart_application", { application: "acme-web" })).json.response.deployment_uuid, "dep_new");
    await h.call("start_application", { application: "docs", force: true });
    await h.call("stop_application", { application: "worker", docker_cleanup: false });
    await h.call("restart_service", { service: "plausible" });
    assert.deepEqual(
      mutatingRequests(h.mock).map((q) => `${q.method} ${q.path} ${JSON.stringify(q.query)}`),
      [
        "POST /api/v1/applications/app1uuid/restart {}",
        'POST /api/v1/applications/app3uuid/start {"force":"true"}',
        'POST /api/v1/applications/app2uuid/stop {"docker_cleanup":"false"}',
        "POST /api/v1/services/svc1uuid/restart {}",
      ],
    );
  });

  it("lists deployments and tails deployment logs", async () => {
    h = await setup();
    const list = await h.call("list_deployments", { application: "acme-web" });
    assert.equal(list.json.total, 1);
    assert.equal(list.json.deployments[0].deployment_uuid, "dep1uuid");
    assert.equal(list.json.deployments[0].logs, undefined);
    assert.equal((await h.call("list_deployments")).json.count, 0);

    const d = await h.call("get_deployment", { deployment_uuid: "dep1uuid", lines: 3 });
    assert.equal(d.json.status, "finished");
    assert.equal(d.json.log_lines_total, 5);
    assert.equal(d.json.logs, "Step 3/3\nDeployment finished.\n[stderr] warning: something");
    assert.ok(!d.text.includes("internal hidden line"));
  });

  it("returns the last N application log lines and explains a stopped app", async () => {
    h = await setup();
    const r = await h.call("get_application_logs", { application: "acme-web", lines: 5 });
    assert.equal(r.json.lines_shown, 5);
    assert.equal(r.json.logs.split("\n")[4], "log line 300");
    const stopped = await h.call("get_application_logs", { application: "docs" });
    assert.equal(stopped.isError, true);
    assert.match(stopped.text, /Application is not running/);
  });
});

describe("errors", () => {
  it("maps 401 and never leaks the token", async () => {
    h = await setup({ clientToken: "9|wrong-token-value-xyz" });
    const r = await h.call("list_applications");
    assert.equal(r.isError, true);
    assert.match(r.text, /token invalid or lacks permission — Coolify: Keys & Tokens, needs read \+ write \(\+ deploy\)/);
    assert.ok(!r.text.includes("wrong-token-value-xyz"));
  });

  it("redacts the token from upstream error bodies", async () => {
    h = await setup();
    h.mock.failNext = { status: 500, body: { message: `boom: header was Authorization: Bearer ${h.mock.token}, raw ${h.mock.token}` } };
    const r = await h.call("list_applications");
    assert.equal(r.isError, true);
    assert.ok(!r.text.includes(h.mock.token), r.text);
    assert.match(r.text, /REDACTED/);
  });

  it("maps 404 (with the resource), 422 validation details and 403 API-disabled", async () => {
    h = await setup();
    const mock = h.mock;
    // An app whose env endpoint 404s.
    mock.applications.push({ id: 9, uuid: "app9uuid", name: "broken", fqdn: null, status: "running", environment_id: 10 });
    const nf = await h.call("list_envs", { resource: "broken" });
    assert.equal(nf.isError, true);
    assert.match(nf.text, /Not found \(404\): application "broken" \(uuid app9uuid\)[\s\S]*Application not found/);

    // The bulk PATCH answers 422 with Laravel-style errors.
    mock.envs.set("application:app9uuid", []);
    const route = (mock as any).route.bind(mock);
    (mock as any).route = (method: string, path: string, rec: unknown, send: (s: number, b: unknown) => void) =>
      method === "PATCH"
        ? send(422, { message: "Validation failed.", errors: { value: ["The value must be a string."] } })
        : route(method, path, rec, send);
    const v = await h.call("set_envs", { resource: "app9uuid", envs: [{ key: "OK_KEY", value: "v" }] });
    assert.equal(v.isError, true);
    assert.match(v.text, /validation failed \(422\)[\s\S]*value: The value must be a string\./i);

    mock.failNext = { status: 403, body: { success: true, message: "API is disabled." } };
    const dis = await h.call("list_services");
    assert.equal(dis.isError, true);
    assert.match(dis.text, /Settings -> Advanced -> API Access/);
  });

  it("reports missing configuration on every call", async () => {
    const { loadConfig } = await import("../src/config.js");
    const { createServer } = await import("../src/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createServer(loadConfig({}));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(a);
    const res = (await client.callTool({ name: "list_applications", arguments: {} })) as any;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /COOLIFY_URL is not set/);
    await client.close();
    await server.close();
  });
});
