#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { redact } from "./client.js";
import { loadConfig } from "./config.js";
import { createServer, VERSION } from "./server.js";

const HELP = `coolify-mcp ${VERSION} — MCP server for the Coolify v4 API (stdio transport)

Usage: coolify-mcp            start the server on stdio (launched by your MCP client)
       coolify-mcp --help     show this help
       coolify-mcp --version  print the version

Environment:
  COOLIFY_URL           instance URL, e.g. https://coolify.example.com (required)
  COOLIFY_TOKEN         API token from Coolify: Keys & Tokens -> API tokens (required)
  COOLIFY_READ_ONLY     1 = refuse every mutating tool
  COOLIFY_ALLOW_REVEAL  1 = allow list_envs with reveal: true (plaintext values)
  COOLIFY_TIMEOUT_MS    per-request timeout in ms (default 30000)

Docs: https://amintt2.github.io/coolify-mcp/`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  const config = loadConfig();
  if (config.configError) {
    // stdout is the MCP channel; diagnostics go to stderr. Tools will report the same message.
    console.error(config.configError);
  }
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(
    `coolify-mcp ready (${config.apiBase || "no COOLIFY_URL"}${config.readOnly ? ", read-only" : ""}${config.allowReveal ? ", reveal allowed" : ""})`,
  );
}

main().catch((err) => {
  const token = process.env.COOLIFY_TOKEN;
  console.error(redact(`coolify-mcp failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}`, token));
  process.exit(1);
});
