# Deployment for XDIGITEX Agent

This document describes installation only. Codex does not deploy or modify production infrastructure.

## Required services

- Node.js 22 and pnpm 9 for API, worker, web build and optional guest daemon
- PostgreSQL 16 with backups and TLS where traffic crosses hosts
- Redis 7 with persistence and authentication
- Proxmox VE 8 / QEMU compute host with cloud-init storage, network bridge, DHCP/IPAM, trusted TLS and a least-privilege API token
- TLS reverse proxy for the web console, API and WebSocket upgrades
- SMTP or transactional email provider for verification and password reset delivery
- Central logs/metrics and a process supervisor (systemd, container runtime, or equivalent)

## Environment categories

Copy `.env.example` into the deployment secret system. Configure application host/port/origin and proxy trust; PostgreSQL `DATABASE_URL`; Redis `REDIS_URL`; 32+ character session secret; high-entropy encryption key; logging; worker heartbeat/reconciliation/metrics intervals; and guest-agent token hash, allowlist, timeout/output limits when used. Build the web app with `VITE_API_URL` pointing at the public `/api/v1` origin.

Do not store `.env`, API tokens, TLS private keys, SSH private keys, provider passwords, or production configuration in Git.

## Install and migrate

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm build
```

Run migrations once as a release step before starting the new API and worker version. Back up PostgreSQL first. Never run development migration commands in production.

## Processes

Start at least one API process with `pnpm start:api`, one infrastructure worker with `pnpm start:worker`, and serve `apps/web/dist` through the reverse proxy. Only the API receives public traffic. Workers need PostgreSQL, Redis and provider-network access. Configure graceful shutdown and restart policies. Run only one reconciliation leader until distributed locking is added.

## Bootstrap

Create the first `SUPER_ADMIN` through an audited, one-time database/bootstrap procedure. In the admin API, create plans, Ubuntu 24.04 image mappings, and a Proxmox host. The host write payload includes `tokenId`, `tokenSecret`, storage pool and bridge; the API encrypts this data.

Confirm the Proxmox token has the minimum permissions documented in `docs/PROVIDERS.md`. Confirm its node, storage, bridge, cloud-init support, DHCP/IPAM and QEMU guest agent. The current create operation expects site-specific image/template preparation to be validated before customer use.

## Health and acceptance checks

1. `GET /health` must return 200.
2. `GET /ready` must show database, Redis and worker as `ok`.
3. Run the admin host health action; it must report real provider connectivity.
4. Register a test tenant, create an API key, and verify another tenant cannot see its resources.
5. Provision a small Ubuntu computer. Observe `CREATING` → `PROVISIONING` → `RUNNING`; a missing host must produce `PROVIDER_UNAVAILABLE`, never success.
6. Verify stop preserves the VM disk, start restores it, reboot and suspend/resume reflect provider status, and delete removes the VM only after confirmation.
7. Create and restore a snapshot. Confirm provider state and audit events.
8. Disconnect provider access and verify reconciliation marks affected state unavailable without deleting records.
9. Confirm real metrics populate after the worker interval; otherwise the UI must say “Metrics unavailable.”
10. Inspect logs and responses for credential leakage, then revoke the test API key and provider token if the environment is disposable.

## Rollback

Keep the previous application build and a pre-migration database backup. Stop new workers before rollback so an older worker cannot consume new job formats. Database migration rollback requires an explicitly reviewed forward-fix or restoration plan; never improvise destructive schema changes.
