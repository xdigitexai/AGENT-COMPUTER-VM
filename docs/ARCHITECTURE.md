# Architecture

## Control plane

The Fastify API owns identity, organizations, permissions, plans, quotas, computer records, hosts, jobs, keys, secrets, usage, billing records, audit events and health. PostgreSQL is authoritative. Every user-facing computer query includes the selected organization ID; administrative routes require server-enforced roles.

Lifecycle requests use compare-and-update state transitions inside transactions. The HTTP request records a durable `ProvisioningJob` and submits only its ID to BullMQ. Provider work never runs in the request process.

## Compute plane

`VirtualizationProvider` defines creation, lifecycle, metrics, snapshot, resize, console, resource and health operations. `ProxmoxProvider` is the first real implementation and uses authenticated Proxmox VE API calls. Provider credentials are AES-256-GCM encrypted in PostgreSQL.

The scheduler filters enabled, healthy, non-maintenance hosts by provider, region and capacity, then chooses the least allocated eligible host. The worker reserves capacity transactionally and invokes the provider. A stopped computer keeps its disk and provider instance; deletion is a distinct operation.

The reconciliation loop compares durable state with provider state. Unreachable providers result in `PROVIDER_UNAVAILABLE`, never a fabricated running state. Metrics are stored only when returned by the provider.

## Agent control plane

API keys are SHA-256 hashed, scoped, expirable and revocable. Agent credentials use the same one-way storage model. The guest daemon binds to loopback by default, authenticates every request, accepts structured process arguments without a shell, enforces an executable allowlist, timeouts and output limits, and emits safe audit events.

## Event and console architecture

The API exposes a WebSocket event endpoint with authenticated-event plumbing ready for Redis fan-out. Provider console sessions are short-lived and returned only after `computer:console` authorization; Proxmox VNC tickets are never persisted. A production reverse proxy should terminate TLS and proxy the provider WebSocket through a narrowly authorized backend endpoint.

## Billing

Plans and subscriptions are provider-neutral. Entitlements and quotas are enforced before creation. `UNAVAILABLE` is an explicit state until an external billing provider is implemented; no payment is simulated.
