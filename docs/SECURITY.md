# Security

## Trust boundaries

The browser never receives provider credentials, stored secret values, password hashes, session hashes, or guest credentials. PostgreSQL and Redis belong on private networks. Provider management endpoints must be reachable only from the worker network. All external traffic requires TLS.

Passwords use Argon2id. Session, API-key and reset tokens are random and stored as SHA-256 hashes. Provider credentials and organization secrets use authenticated AES-256-GCM encryption with a deployment key outside the database. Rotate the encryption key through an offline re-encryption procedure and key-version update.

Every sensitive route authenticates server-side and computer queries include organization ownership. RBAC applies separately from tenant membership. Administrative and lifecycle actions create audit records without secret values. Logs redact authorization headers, cookies and named sensitive fields.

The guest daemon never invokes a shell, accepts only configured executable paths, separates arguments, limits execution time and output, and binds to loopback. Production access should traverse mutually authenticated transport or a control-plane tunnel. Filesystem and screenshot endpoints require a similarly narrow permission model before enabling them.

Use CSRF-resistant SameSite cookies and verify `Origin` at the reverse proxy for browser writes. API tokens are not vulnerable to browser CSRF. Apply database backups, Redis persistence, network policy, OS patching, dependency scanning and centralized audit retention in production.

Report vulnerabilities privately to the repository owners. Do not include credentials or customer data in reports.
