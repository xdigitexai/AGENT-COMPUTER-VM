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

## XDIGITEX Agent API

These endpoints attach an agent to an AI Computer that is **already running**. They never create or
delete a computer, and they never start a second browser: everything an agent does is drawn on the
same visible desktop the operator is watching.

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| POST | `/computers/:id/attach` | `computer:agent` or `computer:console` | Bind an agent run (and optionally a task) to this computer |
| POST | `/computers/:id/detach` | `computer:agent` | End the run, leaving the desktop and computer running |
| POST | `/computers/:id/observe` | `computer:agent` | Screenshot + geometry + the visible browser's tabs |
| POST | `/computers/:id/actions` | `computer:agent` | One desktop or browser action, with an explicit result |
| GET | `/computers/:id/controller` | `computer:read` | Controller state, active run, session status |
| POST | `/computers/:id/controller/request` | `computer:console` or `computer:agent` | A human takes control, or an agent asks for a human |
| POST | `/computers/:id/controller/release` | `computer:console` | Hand control back to the agent |
| GET | `/computers/:id/activity` | `computer:read` | Recent live-activity history |
| GET | `/computers/:id/agent-runs` | `computer:read` | Recent agent runs for this computer |
| GET | `/agent/recipes` | `computer:read` | Tasks the built-in agent can be asked to perform |
| GET | `/api/v1/events?computerId=` | any authenticated | WebSocket tail of that computer's live activity |

`POST /computers/:id/attach` accepts `agentRunId` (reattach), `agentName`, `title`, `instruction`,
`recipe`, and `start`. Passing an `instruction` or `recipe` with `start: true` queues the task on the
worker and returns HTTP 202 with the run.

`POST /computers/:id/actions` takes `{ agentRunId?, label?, action }` where `action.type` is one of:

`move`, `click`, `double_click`, `right_click`, `type`, `key`, `scroll`, `drag`,
`browser_navigate`, `browser_open_tab`, `browser_click`, `browser_type`, `browser_press`,
`browser_evaluate`, `focus_browser`, `open_terminal`, `visible_command`, `terminal_command`,
`screenshot`, `wait`.

Every call answers with `{ ok, message, detail }` — HTTP 200 when the action succeeded and HTTP 422
when it did not, so an agent never has to infer success from a screenshot. Typed text is never
echoed into the activity stream or the audit log.

While a human operator holds control, agent input is refused with `409 CONTROLLER_BUSY` by the
server. Taking and releasing control, and a human sign-in handoff, are published on the activity
stream as `human.took_control`, `human.control_released` and `HUMAN_CONTROL_RELEASED`.

## Access and resources

- `GET|POST /api-keys`, `DELETE /api-keys/:id`
- `GET|POST /secrets`
- `GET /catalog`

API key secret material is returned once. Secret list responses contain metadata only.

## Administration

`/admin/overview`, `/admin/hosts`, `/admin/jobs`, and `/admin/audit-logs` require `ADMIN` or `SUPER_ADMIN`. Host credentials are accepted only on write and are never returned.

Errors use `{ "error": { "code": "...", "message": "..." } }`. Rate limits return HTTP 429.
