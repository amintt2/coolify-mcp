import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CoolifyClient } from "./client.js";
import type { Config } from "./config.js";
import { Coolify } from "./coolify.js";
import { registerTools } from "./tools.js";

export const VERSION = "0.1.0";

export function createServer(config: Config, fetchImpl: typeof fetch = fetch): McpServer {
  const server = new McpServer(
    { name: "coolify-mcp", version: VERSION },
    {
      instructions:
        "Manage a self-hosted Coolify v4 instance: discover projects/apps/services, manage environment variables (values masked by default), deploy, restart and read logs. " +
        "Resources can be referenced by uuid, name or domain substring. After set_envs/delete_env, restart or redeploy for the change to take effect.",
    },
  );
  const client = new CoolifyClient(config, fetchImpl);
  registerTools(server, config, new Coolify(client));
  return server;
}
