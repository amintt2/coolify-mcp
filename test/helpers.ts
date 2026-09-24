import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { MockCoolify, type MockOptions } from "./mock-coolify.js";

export interface CallResult {
  text: string;
  isError: boolean;
  json: any;
}

export interface Harness {
  mock: MockCoolify;
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

export async function setup(
  opts: MockOptions & { readOnly?: boolean; allowReveal?: boolean; token?: string; clientToken?: string } = {},
): Promise<Harness> {
  const mock = new MockCoolify(opts);
  const url = await mock.start();
  const config = loadConfig({
    COOLIFY_URL: `${url}/`,
    COOLIFY_TOKEN: opts.clientToken ?? mock.token,
    COOLIFY_READ_ONLY: opts.readOnly ? "1" : undefined,
    COOLIFY_ALLOW_REVEAL: opts.allowReveal ? "1" : undefined,
  });
  const server = createServer(config);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);

  return {
    mock,
    async call(name, args = {}) {
      const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      const text = res.content.map((c) => c.text).join("\n");
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { text, isError: Boolean(res.isError), json };
    },
    async listTools() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    async close() {
      await client.close();
      await server.close();
      await mock.stop();
    },
  };
}

export function mutatingRequests(mock: MockCoolify) {
  return mock.requests.filter((r) => r.method !== "GET");
}
