import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapHttpError, redact } from "../src/client.js";
import { loadConfig, normalizeBaseUrl } from "../src/config.js";
import { planSetEnvs, viewEnv, type RawEnv } from "../src/envs.js";
import { deploymentLogLines, tail } from "../src/logs.js";
import { maskValue } from "../src/mask.js";
import { resolveAmong, type Named, type ResourceKind } from "../src/resolve.js";

describe("config", () => {
  it("strips trailing slashes and appends /api/v1 once", () => {
    assert.deepEqual(normalizeBaseUrl("https://coolify.example.com///"), {
      baseUrl: "https://coolify.example.com",
      apiBase: "https://coolify.example.com/api/v1",
    });
    assert.equal(normalizeBaseUrl("http://1.2.3.4:8000/api/v1/").apiBase, "http://1.2.3.4:8000/api/v1");
  });
  it("reports missing config instead of throwing, parses flags", () => {
    const c = loadConfig({});
    assert.match(c.configError ?? "", /COOLIFY_URL is not set/);
    assert.match(c.configError ?? "", /COOLIFY_TOKEN is not set/);
    const d = loadConfig({ COOLIFY_URL: "https://x.io", COOLIFY_TOKEN: "t", COOLIFY_READ_ONLY: "1", COOLIFY_ALLOW_REVEAL: "true" });
    assert.equal(d.configError, undefined);
    assert.equal(d.readOnly, true);
    assert.equal(d.allowReveal, true);
    assert.equal(loadConfig({ COOLIFY_URL: "https://x.io", COOLIFY_TOKEN: "t", COOLIFY_READ_ONLY: "0" }).readOnly, false);
  });
});

describe("maskValue", () => {
  it("masks with a short prefix and the length", () => {
    assert.equal(maskValue("postgres://user:pass@host/db"), "post*** (28 chars)");
    assert.equal(maskValue(""), "(empty)");
    assert.equal(maskValue(null), "(empty)");
  });
  it("never reveals short secrets in full", () => {
    assert.equal(maskValue("abcd"), "a*** (4 chars)");
    assert.equal(maskValue("ab"), "*** (2 chars)");
    assert.ok(!maskValue("secret").includes("secret"));
  });
});

describe("redact / error mapping", () => {
  const token = "3|supersecrettokenvalue";
  it("removes the token and bearer credentials", () => {
    const out = redact(`failed with Authorization: Bearer ${token} and raw ${token}`, token);
    assert.ok(!out.includes(token));
    assert.ok(!out.includes("supersecret"));
    assert.match(out, /REDACTED/);
    assert.ok(!redact('{"authorization":"Bearer abcdefghijkl"}').includes("abcdefghijkl"));
  });
  it("maps statuses to actionable messages", () => {
    assert.match(mapHttpError(401, { message: "Unauthenticated." }, "GET", "/applications"), /token invalid or lacks permission — Coolify: Keys & Tokens, needs read \+ write \(\+ deploy\)/);
    assert.match(mapHttpError(400, { message: "Invalid token." }, "GET", "/x"), /token invalid or lacks permission/);
    assert.match(mapHttpError(404, { message: "Application not found" }, "GET", "/applications/zz/envs", 'application "web" (uuid zz)'), /Not found \(404\): application "web" \(uuid zz\)/);
    const v = mapHttpError(422, { message: "Validation failed.", errors: { key: ["The key field format is invalid."] } }, "PATCH", "/applications/a/envs/bulk");
    assert.match(v, /Validation failed\..*key: The key field format is invalid\./);
    assert.match(mapHttpError(403, { success: true, message: "API is disabled." }, "GET", "/x"), /API Access/);
    assert.match(mapHttpError(403, { message: "Missing required permissions: deploy" }, "POST", "/deploy"), /deploy/);
  });
});

describe("resolveAmong", () => {
  const items: Array<{ kind: ResourceKind; item: Named }> = [
    { kind: "application" as const, item: { uuid: "u1", name: "web", fqdn: "https://app.example.com" } },
    { kind: "application" as const, item: { uuid: "u2", name: "web-worker", fqdn: null } },
    { kind: "application" as const, item: { uuid: "u3", name: "docs", fqdn: "https://docs.example.com,https://www.docs.example.com" } },
  ];
  it("resolves by uuid, exact name (even if also a substring of others), domain and unique substring", () => {
    assert.equal(resolveAmong(items, "u2", "application").item.name, "web-worker");
    assert.equal(resolveAmong(items, "WEB", "application").item.uuid, "u1");
    assert.equal(resolveAmong(items, "app.example.com", "application").item.uuid, "u1");
    assert.equal(resolveAmong(items, "https://www.docs.example.com/", "application").item.uuid, "u3");
    assert.equal(resolveAmong(items, "work", "application").item.uuid, "u2");
  });
  it("prefers a repo:branch name and name hits over domain hits", () => {
    const apps: Array<{ kind: ResourceKind; item: Named }> = [
      { kind: "application" as const, item: { uuid: "m1", name: "acme:main", fqdn: "https://acme.dev" } },
      { kind: "application" as const, item: { uuid: "m2", name: "legacy:main-redirect", fqdn: "https://acme.old.dev" } },
    ];
    assert.equal(resolveAmong(apps, "acme", "application").item.uuid, "m1");
    assert.equal(resolveAmong(apps, "legacy", "application").item.uuid, "m2");
    assert.equal(resolveAmong(apps, "acme.old", "application").item.uuid, "m2");
  });
  it("errors clearly on ambiguity and no match", () => {
    assert.throws(() => resolveAmong(items, "example.com", "application"), /ambiguous — it matches 2 applications[\s\S]*u1[\s\S]*u3[\s\S]*Pass the uuid/);
    assert.throws(() => resolveAmong(items, "nope", "application"), /No application matches "nope"[\s\S]*web-worker/);
  });
});

describe("planSetEnvs", () => {
  const existing: RawEnv[] = [
    { uuid: "e1", key: "A", value: "one", is_preview: false, is_literal: true, is_multiline: false, is_buildtime: false, is_runtime: true },
    { uuid: "e2", key: "B", value: "two", is_preview: false, is_literal: false, is_multiline: true, is_buildtime: true, is_runtime: true },
    { uuid: "e3", key: "A", value: "prev", is_preview: true, is_literal: false, is_multiline: false, is_buildtime: true, is_runtime: true },
  ];

  it("classifies created / updated / unchanged and only sends changes", () => {
    const plan = planSetEnvs(
      existing,
      [
        { key: "A", value: "one" },
        { key: "B", value: "TWO" },
        { key: "C", value: "three", is_build_time: false },
        { key: "A", value: "prev2", is_preview: true },
      ],
      "application",
    );
    assert.deepEqual(
      plan.entries.map((e) => [e.key, e.is_preview, e.status]),
      [["A", false, "unchanged"], ["B", false, "updated"], ["C", false, "created"], ["A", true, "updated"]],
    );
    assert.equal(plan.payload.length, 3);
    const b = plan.payload.find((p) => p.key === "B")!;
    assert.equal(b.is_multiline, true, "existing flags are carried over on update");
    const c = plan.payload.find((p) => p.key === "C")!;
    assert.equal(c.is_buildtime, false);
    assert.equal(c.is_build_time, false);
    assert.ok(!JSON.stringify(plan.entries).includes("TWO"), "entries never contain values");
  });

  it("flag-only changes count as updates; trimmed-equal values are unchanged", () => {
    const plan = planSetEnvs(existing, [{ key: "A", value: " one \n", is_literal: false }, { key: "B", value: "two  " }], "application");
    assert.equal(plan.entries[0].status, "updated");
    assert.deepEqual(plan.entries[0].changes, ["is_literal"]);
    assert.equal(plan.entries[1].status, "unchanged");
  });

  it("marks values it cannot read as updates, and validates keys", () => {
    const hidden: RawEnv[] = [{ uuid: "e1", key: "A", is_literal: false }];
    const plan = planSetEnvs(hidden, [{ key: "A", value: "x" }], "application");
    assert.equal(plan.entries[0].status, "updated");
    assert.match(plan.entries[0].changes[0], /not comparable/);
    assert.throws(() => planSetEnvs([], [{ key: "1BAD", value: "x" }], "application"), /Invalid key "1BAD"/);
    assert.throws(() => planSetEnvs([], [{ key: "BAD-KEY", value: "x" }], "application"), /Invalid key/);
    assert.throws(() => planSetEnvs([], [{ key: "A", value: "x" }, { key: "A", value: "y" }], "application"), /twice/);
  });

  it("services ignore preview/build flags", () => {
    const plan = planSetEnvs([], [{ key: "S", value: "v", is_preview: true, is_build_time: false }], "service");
    assert.deepEqual(plan.payload[0], { key: "S", value: "v" });
    assert.match(plan.entries[0].notes?.[0] ?? "", /ignored/);
  });
});

describe("viewEnv", () => {
  it("masks by default and flags hidden values", () => {
    assert.equal(viewEnv({ uuid: "u", key: "K", value: "abcdefghijkl" }, false).value, "abcd*** (12 chars)");
    assert.equal(viewEnv({ uuid: "u", key: "K", value: "abcdefghijkl" }, true).value, "abcdefghijkl");
    assert.match(viewEnv({ uuid: "u", key: "K" }, true).value, /read:sensitive/);
    assert.match(viewEnv({ uuid: "u", key: "K", is_shown_once: true }, true).value, /shown once/);
    assert.equal(viewEnv({ uuid: "u", key: "K", is_build_time: true }, false).is_build_time, true, "old field name");
  });
});

describe("deployment logs", () => {
  it("parses Coolify's JSON log format, drops hidden entries, tails", () => {
    const logs = JSON.stringify([
      { output: "one\ntwo", hidden: false, type: "stdout" },
      { output: "secret", hidden: true },
      { output: "three", hidden: false, type: "stderr" },
    ]);
    const lines = deploymentLogLines(logs);
    assert.deepEqual(lines, ["one", "two", "[stderr] three"]);
    assert.deepEqual(tail(lines, 2), { text: "two\n[stderr] three", total: 3, shown: 2 });
    assert.deepEqual(deploymentLogLines("plain\ntext\n"), ["plain", "text"]);
  });
});
