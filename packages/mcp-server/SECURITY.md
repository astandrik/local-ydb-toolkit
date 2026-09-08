# Security Policy

## Supported versions

Security fixes are supported for the latest npm release of `@astandrik/local-ydb-mcp` and the current `main` branch. Older releases may be asked to upgrade before a fix is prepared.

## Reporting a vulnerability

Report suspected vulnerabilities through [GitHub Private Vulnerability Reporting](https://github.com/astandrik/local-ydb-toolkit/security/advisories/new). Do not open a public issue for an undisclosed vulnerability.

Do not include credentials, tokens, private hostnames, private filesystem paths, SSH identity contents, password-file contents, or other secrets in a report. Use redacted examples and describe how maintainers can reproduce the issue without access to private infrastructure.

## Security model

The MCP server is intended for local, development, and test environments. Run it with the least-privileged operating-system account, Docker access, SSH credentials, YDB credentials, and filesystem permissions that can perform the required task.

The server inherits the authority of its process and configured targets:

- access to the Docker daemon can control containers and may imply broad host privileges;
- SSH profiles can execute commands with the permissions of the configured remote account and identity;
- YDB CLI operations use the endpoint, database, user, token, and password-file access available to the process;
- local configuration, identity, password, dump, and restore files are readable or writable according to the process filesystem permissions.

Mutating MCP tools are plan-first. Execution requires `confirm: true` plus a process-bound, one-time HMAC token returned for the current exact plan. The token is consumed before the first side effect, expires on MCP restart, and is rejected when the tool, target, config source, execution inputs, or current plan change. It is an ephemeral capability, not proof of human approval; MCP hosts and clients remain responsible for obtaining that approval and must not log or persist tokens. This application-level gate is not an operating-system sandbox, an authentication boundary, an authorization system, or a replacement for least-privilege credentials and host controls.

Keep configuration and credential files outside the repository, restrict their permissions, use dedicated development credentials, and review generated command plans before confirming them. Avoid granting the MCP process production credentials or access to unrelated hosts and files.

Arbitrary configuration files remain supported through an absolute `configPath` tool argument or an absolute `LOCAL_YDB_TOOLKIT_CONFIG` value. A present but empty environment value remains explicit and is rejected. Explicit files must exist, be readable regular files no larger than 1 MiB, and match the strict configuration schema. An explicit configuration error fails closed instead of selecting the built-in profile. Error responses expose a stable configuration code without returning the file contents, JSON parser context, schema input, stack or cause, or the absolute path.
