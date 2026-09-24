import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MockCoolify } from "./mock-coolify.js";

// .test-build/test/smoke.test.js -> <repo>/dist/index.js
const entry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

describe("MCP smoke test over stdio (built server)", () => {
  const mock = new MockCoolify();
  let client: Client;
  let transport: StdioClientTransport;

  before(async () => {
    const url = await mock.start();
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: { PATH: process.env.PATH ?? "", COOLIFY_URL: url, COOLIFY_TOKEN: mock.token },
      stderr: "pipe",
    });
    client = new Client({ name: "smoke", version: "0.0.0" });
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
    await mock.stop();
  });

  it("lists the tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "delete_env",
      "deploy",
      "get_application",
      "get_application_logs",
      "get_deployment",
      "get_version",
      "list_applications",
      "list_databases",
      "list_deployments",
      "list_envs",
      "list_projects",
      "list_servers",
      "list_services",
      "restart_application",
      "restart_service",
      "set_envs",
      "start_application",
      "stop_application",
    ]);
  });

  it("calls list_envs against the mock, values masked", async () => {
    const res = (await client.callTool({ name: "list_envs", arguments: { resource: "acme-web" } })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    assert.ok(!res.isError, res.content[0]?.text);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.resource.uuid, "app1uuid");
    assert.ok(body.envs.some((e: { key: string }) => e.key === "DATABASE_URL"));
    assert.ok(!res.content[0].text.includes("hunter2"));
  });
});
