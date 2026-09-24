# coolify-mcp

**Let your AI agent run your self-hosted [Coolify](https://coolify.io): list apps, manage env vars safely, deploy, restart and read logs.**

[![CI](https://github.com/amintt2/coolify-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/amintt2/coolify-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server for the Coolify v4 REST API. Works with Claude Code, Claude Desktop,
Cursor, VS Code, Windsurf and any other stdio MCP client. No install step: your client runs it with
`npx -y github:amintt2/coolify-mcp`.

**Website and config generator:** https://amintt2.github.io/coolify-mcp/ (type your Coolify URL, pick your client,
copy the snippet or click *Add to Cursor* / *Add to VS Code*).

## Why this one

- **Secrets are masked by default.** `list_envs` shows `post*** (41 chars)`, not your database password. Plaintext needs
  `reveal: true` in the call **and** `COOLIFY_ALLOW_REVEAL=1` on the server, so an agent can't decide on its own to read them.
- **Dry runs.** `set_envs` and `delete_env` take `dry_run: true` and report what would change (`created` / `updated` /
  `unchanged` per key) without touching anything. Values are never echoed back.
- **Read-only mode.** `COOLIFY_READ_ONLY=1` refuses every mutating tool. Good for "look but don't touch" sessions.
- **Coolify quirks handled.** Coolify's bulk env endpoint silently resets `is_literal`, `is_multiline` and
  `is_shown_once` when they are omitted, so `set_envs` resends the current flags for each key it updates. It also sends both
  the current `is_buildtime` flag and the older beta name `is_build_time`.
- **Human references.** Point at an app by uuid, name or part of its domain (`"api"`, `"shop.example.com"`). Ambiguous
  references fail and list the candidates instead of guessing.
- **Token hygiene.** The token is never logged and is redacted from every error message.

## Quick start

You need **Node.js 20+** and **git** (npx fetches the server from GitHub on first run), plus a Coolify v4 instance.

### 1. Enable the API

Coolify → **Settings → Advanced** → turn on **API Access**. If *Allowed IPs* is set there, add the IP of the machine
that will run the MCP server (your laptop, usually).

### 2. Create a token

Coolify → **Keys & Tokens → API tokens → Create**. The token is scoped to the team you are in. Recommended permissions:

| Permission | Needed for |
|---|---|
| `read` | Listing, env keys and flags, deployments, app logs. The minimum. |
| `read:sensitive` | Env **values** (to mask them and to tell `unchanged` from `updated`) and **deployment logs**. Values reach this server and are masked before they reach the agent. |
| `write` | `set_envs`, `delete_env` |
| `deploy` | `deploy`, `start_application`, `stop_application`, `restart_application`, `restart_service` |

Don't use `root`. For an inspection-only setup, give `read` (+ `read:sensitive`) and run with `COOLIFY_READ_ONLY=1`.
Only team admins and owners can create tokens with `write`, `deploy` or `read:sensitive`.

### 3. Add it to your client

Replace `https://coolify.example.com` with your instance and `<YOUR_COOLIFY_TOKEN>` with the token.

<details open>
<summary><b>Claude Code</b></summary>

```sh
claude mcp add coolify --scope user \
  -e COOLIFY_URL="https://coolify.example.com" \
  -e COOLIFY_TOKEN="<YOUR_COOLIFY_TOKEN>" \
  -- npx -y github:amintt2/coolify-mcp
```

Add `-e COOLIFY_READ_ONLY=1` or `-e COOLIFY_ALLOW_REVEAL=1` to turn those on. Check with `claude mcp list`.
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config), at
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or
`%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": ["-y", "github:amintt2/coolify-mcp"],
      "env": {
        "COOLIFY_URL": "https://coolify.example.com",
        "COOLIFY_TOKEN": "<YOUR_COOLIFY_TOKEN>"
      }
    }
  }
}
```

Restart Claude Desktop. If it can't find `npx` (common with nvm), use the absolute path from `which npx`.
</details>

<details>
<summary><b>Cursor</b></summary>

One click: use the **Add to Cursor** button on the [website](https://amintt2.github.io/coolify-mcp/#generator), or open
this deeplink (it installs with placeholder values; edit the token afterwards in *Settings → MCP*):

```
cursor://anysphere.cursor-deeplink/mcp/install?name=coolify&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImdpdGh1YjphbWludHQyL2Nvb2xpZnktbWNwIl0sImVudiI6eyJDT09MSUZZX1VSTCI6Imh0dHBzOi8vY29vbGlmeS5leGFtcGxlLmNvbSIsIkNPT0xJRllfVE9LRU4iOiI8WU9VUl9DT09MSUZZX1RPS0VOPiJ9fQ%3D%3D
```

The `config` parameter is the base64 of the server JSON (`{"command": ..., "args": ..., "env": ...}`).

Or by hand, in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": ["-y", "github:amintt2/coolify-mcp"],
      "env": {
        "COOLIFY_URL": "https://coolify.example.com",
        "COOLIFY_TOKEN": "<YOUR_COOLIFY_TOKEN>"
      }
    }
  }
}
```
</details>

<details>
<summary><b>VS Code (GitHub Copilot agent mode)</b></summary>

From a terminal:

```sh
code --add-mcp '{"name":"coolify","type":"stdio","command":"npx","args":["-y","github:amintt2/coolify-mcp"],"env":{"COOLIFY_URL":"https://coolify.example.com","COOLIFY_TOKEN":"<YOUR_COOLIFY_TOKEN>"}}'
```

Or per workspace in `.vscode/mcp.json`, where VS Code prompts for the token once and stores it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "coolify-token", "description": "Coolify API token", "password": true }
  ],
  "servers": {
    "coolify": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:amintt2/coolify-mcp"],
      "env": {
        "COOLIFY_URL": "https://coolify.example.com",
        "COOLIFY_TOKEN": "${input:coolify-token}"
      }
    }
  }
}
```

The website also has an **Add to VS Code** button (`vscode:mcp/install?...`).
</details>

<details>
<summary><b>Windsurf</b></summary>

Edit `~/.codeium/windsurf/mcp_config.json` (Windsurf Settings → Cascade → MCP servers → *View raw config*):

```json
{
  "mcpServers": {
    "coolify": {
      "command": "npx",
      "args": ["-y", "github:amintt2/coolify-mcp"],
      "env": {
        "COOLIFY_URL": "https://coolify.example.com",
        "COOLIFY_TOKEN": "<YOUR_COOLIFY_TOKEN>"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Any other stdio MCP client</b></summary>

Command `npx`, arguments `-y github:amintt2/coolify-mcp`, environment `COOLIFY_URL` and `COOLIFY_TOKEN`:

```json
{
  "command": "npx",
  "args": ["-y", "github:amintt2/coolify-mcp"],
  "env": {
    "COOLIFY_URL": "https://coolify.example.com",
    "COOLIFY_TOKEN": "<YOUR_COOLIFY_TOKEN>"
  }
}
```

To run from a local clone instead: `npm install` (builds `dist/` via `prepare`), then use
`node /path/to/coolify-mcp/dist/index.js` as the command.
</details>

Then ask your agent something like *"Which Coolify apps are unhealthy?"*, *"Set LOG_LEVEL=debug on the api app, dry run
first"* or *"Redeploy the web app and show me the build log"*.

The first launch takes a little longer: npx clones the repo and compiles it once, then caches it.

## Tools

18 tools. Every tool that takes an application or service accepts a uuid, the exact name, or a unique part of the name or
domain.

| Area | Tool | What it does |
|---|---|---|
| Discovery | `get_version` | Coolify version, health, API base in use, read-only / reveal flags. Call first when something fails. |
| | `list_projects` | Projects and their environments |
| | `list_servers` | Servers, IPs, reachability, proxy type |
| | `list_applications` | Name, uuid, fqdn, status, git repo/branch, project/environment (`filter` optional) |
| | `get_application` | One application's details, secrets stripped |
| | `list_services` | One-click / compose services (`filter` optional) |
| | `list_databases` | Standalone databases, no credentials |
| Env vars | `list_envs` | Keys, uuids and flags of an app or service, values masked (`key_filter`, `reveal`) |
| | `set_envs` | Upsert up to 200 `{key, value, is_build_time?, is_runtime?, is_preview?, is_literal?, is_multiline?}` in one call; `dry_run` |
| | `delete_env` | Delete a key (`is_preview` selects the preview copy); `dry_run` |
| Lifecycle | `deploy` | Deploy by resource (uuid/name, comma-separated) or Coolify tag; `force` rebuilds without cache |
| | `restart_application` | Restart containers without rebuilding (picks up runtime env changes) |
| | `start_application` | Start a stopped app (`force`, `instant_deploy`) |
| | `stop_application` | Stop an app (`docker_cleanup`) |
| | `restart_service` | Restart a service, optionally pulling latest images |
| Observability | `list_deployments` | Recent deployments of an app, or everything queued / in progress |
| | `get_deployment` | Status plus the last N build/deploy log lines (default 100) |
| | `get_application_logs` | Last N container log lines of a running app |

Env changes apply after a restart (runtime variables) or a redeploy (build-time variables). `set_envs` says which in its
result. Mutating tools carry MCP `destructiveHint` / `readOnlyHint` annotations so clients can ask before running them.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `COOLIFY_URL` | yes | Instance URL, e.g. `https://coolify.example.com`. A trailing slash or `/api/v1` is stripped; `/api/v1` is added. |
| `COOLIFY_TOKEN` | yes | API token (sent as `Authorization: Bearer`). |
| `COOLIFY_READ_ONLY` | no | `1` refuses every mutating tool. Dry runs are still allowed. |
| `COOLIFY_ALLOW_REVEAL` | no | `1` lets `list_envs` return plaintext when called with `reveal: true`. Off by default. |
| `COOLIFY_TIMEOUT_MS` | no | Per-request timeout in ms. Default `30000`. |

`npx -y github:amintt2/coolify-mcp --help` prints the same list.

## Security notes

- The server runs locally over stdio. It talks only to your `COOLIFY_URL`; there is no telemetry and no other network access.
- Your token lives in your MCP client's config. Prefer a client that stores secrets securely (VS Code `inputs`), keep config
  files out of git, and scope the token to the permissions you actually want the agent to have.
- With `read:sensitive`, env values are fetched from Coolify so they can be compared and masked, but they are not
  returned to the agent unless you enabled `COOLIFY_ALLOW_REVEAL=1` **and** the agent asked for `reveal: true`.
- Service and database listings strip credentials; application details strip webhook secrets and basic-auth passwords.
- `stop_application` and `delete_env` are marked destructive. Use `COOLIFY_READ_ONLY=1` when you only want answers.
- Anything the agent reads (app names, logs) is still shown to your model provider. Don't reveal secrets you wouldn't paste
  into a chat.

Found a vulnerability? Please open a [private security advisory](https://github.com/amintt2/coolify-mcp/security/advisories/new)
rather than a public issue.

## Coolify API notes

- `PATCH /{applications|services}/{uuid}/envs/bulk` with `{"data": [...]}` is an upsert. On applications it resets
  `is_literal`, `is_multiline` and `is_shown_once` when they are omitted, so `set_envs` sends the current flags for every
  key it updates.
- The build-time flag is `is_buildtime` (with `is_runtime`) on current Coolify and `is_build_time` on older betas.
  `set_envs` sends both; the endpoint ignores the one it doesn't know.
- Service env vars have no preview or build-time flags. Coolify trims values and stores an empty value as null.
- Application env listings include preview copies: the same key can exist once as a main copy and once as a preview copy
  (`is_preview`).

## Contributing

Issues and pull requests are welcome.

```sh
git clone https://github.com/amintt2/coolify-mcp && cd coolify-mcp
npm install     # also builds dist/ through the prepare script
npm test        # build, then node:test unit tests + an MCP stdio smoke test against an in-process mock Coolify
npm run dev     # tsc --watch
```

Tests never talk to a real Coolify. When you add a tool, add it to the mock in `test/mock-coolify.ts`, cover it in
`test/tools.test.ts` and update the tool list in `test/smoke.test.ts`, this README and `docs/index.html`.

To try a local build in Claude Code:
`claude mcp add coolify-dev -e COOLIFY_URL=... -e COOLIFY_TOKEN=... -- node "$PWD/dist/index.js"`.

## License

[MIT](LICENSE) © Tahar Amin. Not affiliated with Coolify.
