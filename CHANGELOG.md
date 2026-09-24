# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-24

First public release.

### Added

- 18 tools for the Coolify v4 REST API: discovery (`get_version`, `list_projects`,
  `list_servers`, `list_applications`, `get_application`, `list_services`,
  `list_databases`), environment variables (`list_envs`, `set_envs`, `delete_env`),
  lifecycle (`deploy`, `restart_application`, `start_application`,
  `stop_application`, `restart_service`) and observability (`list_deployments`,
  `get_deployment`, `get_application_logs`).
- Env values masked by default; plaintext only with `reveal: true` and
  `COOLIFY_ALLOW_REVEAL=1`.
- `dry_run` on `set_envs` / `delete_env`; `COOLIFY_READ_ONLY=1` refuses every
  mutating tool.
- `set_envs` resends existing `is_literal` / `is_multiline` / `is_shown_once` flags
  so Coolify's bulk endpoint does not reset them, and sends both `is_buildtime`
  and the older `is_build_time` flag name.
- Resources resolvable by uuid, name or domain substring, with ambiguity errors
  that list the candidates.
- Token redacted from every error and log line.
- `--help` / `--version` flags; `prepare` script so
  `npx -y github:amintt2/coolify-mcp` builds and runs straight from GitHub.

[0.1.0]: https://github.com/amintt2/coolify-mcp/releases/tag/v0.1.0
