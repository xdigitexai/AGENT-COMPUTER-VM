# XDIGITEX AGENT COMPUTER

Cloud computers built for AI agents. This repository contains the control plane, cloud console, infrastructure worker, real Proxmox integration, and a constrained guest daemon for persistent virtual computers.

The platform never reports simulated infrastructure success. Without a configured and reachable compute host, provisioning ends in `PROVIDER_UNAVAILABLE` or a specific configuration error.

## Services

- `apps/api`: Fastify REST API, authentication, RBAC, tenancy, lifecycle orchestration, administration, health endpoints
- `apps/api/src/worker.ts`: BullMQ infrastructure worker, Docker/Proxmox provider calls, metrics, usage and reconciliation
- `apps/web`: responsive React cloud console
- `apps/guest-agent`: authenticated allowlist-based guest command service
- PostgreSQL: durable platform state, audit logs, jobs, metrics, usage and billing records
- Redis: BullMQ queues, retries and worker discovery
- `infrastructure/images/agent-computer`: maintained Ubuntu 24.04/Playwright AI Computer image

## Local development

Requirements: Node.js 22+, pnpm 9+, PostgreSQL 16+, Redis 7+.

```sh
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Run the infrastructure worker separately with `pnpm start:worker`. The web console defaults to `http://localhost:3000` and the API to `http://localhost:4000`. Set `VITE_API_URL` at web build time when those origins differ.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
```

Production requirements, environment categories, migration and service commands, provider registration, and acceptance checks are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PROVIDERS.md](docs/PROVIDERS.md), [docs/API.md](docs/API.md), [docs/SECURITY.md](docs/SECURITY.md), and [docs/GUEST-AGENT.md](docs/GUEST-AGENT.md).

Docker and Proxmox are independent implementations of the same provider contract. A single-VPS installation can use the local Docker Engine without KVM. Users continue to create “AI Computers”; Docker details remain in the administrative infrastructure view.
