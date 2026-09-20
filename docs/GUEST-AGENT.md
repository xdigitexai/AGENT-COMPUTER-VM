# Guest agent

The guest agent is a small service intended to run inside a provisioned computer. It provides health, system information, and structured command execution. It is deliberately disabled until `GUEST_AGENT_TOKEN_HASH` and `GUEST_AGENT_ALLOWED_COMMANDS` are configured.

Requests use `Authorization: Bearer <credential>`. Store only the SHA-256 hash in the guest. Bind the process to loopback and expose it through an authenticated tunnel; never publish the port directly.

Command requests contain `executable`, an argument array, optional working directory, and a bounded timeout. The daemon uses `spawn` with `shell: false`, checks an exact executable allowlist, caps combined stream collection, and kills timed-out processes. The control plane models command requests/results and audit ownership. File transfer, screenshots, browser control and process inspection should be added as separate permission-scoped operations, not generic shell strings.

Run under a dedicated unprivileged OS account. Use systemd hardening (`NoNewPrivileges`, `ProtectSystem`, `PrivateTmp`), rotate credentials, and restrict outbound control-plane access.
