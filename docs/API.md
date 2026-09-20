# API

The base path is `/api/v1`. Browser sessions use an HTTP-only, secure, SameSite cookie. Developers use `Authorization: Bearer xdg_...`. Mutating infrastructure requests should include a unique `Idempotency-Key`.

## Authentication

- `POST /auth/register`, `/auth/login`, `/auth/logout`
- `POST /auth/forgot-password`, `/auth/reset-password`

Password reset delivery is an integration boundary: the API records a hashed, expiring token and emits a safe delivery event; production must connect an email provider.

## Computers

- `POST /computers`, `GET /computers`, `GET /computers/:id`
- `POST /computers/:id/start|stop|restart|suspend|resume|delete`
- `GET /computers/:id/metrics`
- `POST /computers/:id/commands` (requires `computer:agent`; provider capability dependent)
- `POST|GET /computers/:id/snapshots`
- `POST /computers/:id/snapshots/:snapshotId/restore`

Accepted lifecycle calls return HTTP 202 with the durable job. Invalid transitions return 409. Tenant ownership is checked before all reads and actions.

Command bodies contain `executable`, an `arguments` array, `timeoutMs`, and `outputLimitBytes`. The API never accepts a host container ID or shell command string. Provider capabilities are returned on the computer detail response so unsupported actions can be hidden.

## Access and resources

- `GET|POST /api-keys`, `DELETE /api-keys/:id`
- `GET|POST /secrets`
- `GET /catalog`

API key secret material is returned once. Secret list responses contain metadata only.

## Administration

`/admin/overview`, `/admin/hosts`, `/admin/jobs`, and `/admin/audit-logs` require `ADMIN` or `SUPER_ADMIN`. Host credentials are accepted only on write and are never returned.

Errors use `{ "error": { "code": "...", "message": "..." } }`. Rate limits return HTTP 429.
