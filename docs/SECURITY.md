# Security

## Trust boundaries

The browser never receives provider credentials, stored secret values, password hashes, session hashes, or guest credentials. PostgreSQL and Redis belong on private networks. Provider management endpoints must be reachable only from the worker network. All external traffic requires TLS.

Passwords use Argon2id. Session, API-key and reset tokens are random and stored as SHA-256 hashes. Provider credentials and organization secrets use authenticated AES-256-GCM encryption with a deployment key outside the database. Rotate the encryption key through an offline re-encryption procedure and key-version update.

Every sensitive route authenticates server-side and computer queries include organization ownership. RBAC applies separately from tenant membership. Administrative and lifecycle actions create audit records without secret values. Logs redact authorization headers, cookies and named sensitive fields.

The guest daemon never invokes a shell, accepts only configured executable paths, separates arguments, limits execution time and output, and binds to loopback. Production access should traverse mutually authenticated transport or a control-plane tunnel. Filesystem and screenshot endpoints require a similarly narrow permission model before enabling them.

## Docker isolation

The worker's Docker socket access is equivalent to host-root authority. Limit it to the worker service account and never mount the socket into AI Computers. XDIGITEX containers run unprivileged as UID 10001 with all capabilities dropped, `no-new-privileges`, a read-only root filesystem, CPU/RAM/PID limits, bounded tmpfs, one managed home volume mounted at `/home/agent`, no host mounts, no published ports and a dedicated bridge with inter-container communication disabled. Host firewall rules must also prevent that bridge from reaching PostgreSQL, Redis, provider management endpoints and instance metadata while permitting intended outbound internet access.

## Desktop streaming

A live agent desktop adds two container-internal listeners, and both stay inside the container
network:

- `x11vnc` binds the VNC port to the container's **loopback only**, so the raw VNC protocol is
  never reachable from the host, from the internet or from another container.
- `websockify` serves noVNC on the container's desktop port. That port is never published, and
  inter-container communication is disabled on the managed network, so only the control plane can
  reach it.

The browser never talks to the container. `GET /api/v1/computers/{id}/desktop` is an authenticated
WebSocket on the public origin: the API validates the session or API key, checks that the computer
belongs to the caller's organization, and only then relays frames. Unauthenticated upgrade
attempts are rejected with `401` before any container connection is made.

Chromium also exposes the DevTools protocol, and Chrome refuses to bind that endpoint to anything
but loopback. The control plane therefore drives browser navigation over the container's own
loopback through the Node.js runtime in the image, using the container's `docker exec` channel
that is already restricted to the agent user. Chromium runs with `--no-sandbox` because all Linux
capabilities are dropped inside the container; the container remains the isolation boundary, and
the Chromium sandbox must not be relied on here.

The shared-control lock is enforced in Redis and checked on the server for every input action, not
in the interface: while a human operator holds control, agent input from an API key is refused with
`409 CONTROLLER_BUSY`, and only an interactive signed-in session can take or release control.


Linux containers share the host kernel and provide a weaker isolation boundary than hardware-backed VMs. Keep Docker, the host kernel and the base image patched; use seccomp/AppArmor defaults; consider rootless Docker or an additional sandbox such as gVisor where supported; and place mutually untrusted high-risk tenants on separate hosts or Proxmox VMs.

Use CSRF-resistant SameSite cookies and verify `Origin` at the reverse proxy for browser writes. API tokens are not vulnerable to browser CSRF. Apply database backups, Redis persistence, network policy, OS patching, dependency scanning and centralized audit retention in production.

Report vulnerabilities privately to the repository owners. Do not include credentials or customer data in reports.
