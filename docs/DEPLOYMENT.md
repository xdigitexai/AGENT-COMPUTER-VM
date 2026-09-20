# Deployment for XDIGITEX Agent

This document describes installation only. Codex does not deploy or modify production infrastructure.

## Required services

- Node.js 22 and pnpm 9 for API, worker, web build and optional guest daemon
- PostgreSQL 16 with backups and TLS where traffic crosses hosts
- Redis 7 with persistence and authentication
- Proxmox VE 8 / QEMU compute host with cloud-init storage, network bridge, DHCP/IPAM, trusted TLS and a least-privilege API token
- Docker Engine 27+ for single-VPS or container-backed compute (KVM is not required)
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

## Single-VPS Docker Compute Deployment

These commands target Ubuntu 24.04. Review them against the server's package policy before execution.

### 1. Install and verify Docker Engine

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker info
```

Give only the infrastructure worker service account socket access. Docker group membership is root-equivalent; do not add web users or customer processes.

```sh
sudo usermod -aG docker <worker-service-user>
sudo systemctl restart <worker-service-name>
```

### 2. Build the approved AI Computer image

From the checked-out repository:

```sh
sudo docker build --pull \
  -t xdigitex/agent-computer:2026.09 \
  infrastructure/images/agent-computer
sudo docker image inspect xdigitex/agent-computer:2026.09
sudo docker run --rm --entrypoint /bin/sh xdigitex/agent-computer:2026.09 \
  -c 'id && node --version && python3 --version && chromium --version'
```

Pin a reviewed production digest if the image is pushed to a registry. Run `pnpm --filter @xdigitex/api seed` after migrations to register the `docker` image mapping, or create the same `ComputerImage` through an audited admin procedure.

### 3. Create the managed network

The provider creates it if absent; pre-creating it makes firewall review explicit:

```sh
sudo docker network create \
  --driver bridge \
  --opt com.docker.network.bridge.enable_icc=false \
  --label xdigitex.managed=true \
  xdigitex-computers
sudo docker network inspect xdigitex-computers
```

Apply host firewall rules that deny this bridge access to PostgreSQL, Redis, the Docker API, provider management ports and cloud metadata. Allow only intended outbound internet traffic. Do not publish container ports.

### 4. Register the local compute host

Sign in as `ADMIN`/`SUPER_ADMIN`, open **Administration → Register a Docker compute host**, and use:

- name: `XDIGITEX Local Compute`
- endpoint: `unix:///var/run/docker.sock`
- node: `local`
- region: `local-1`
- network: `xdigitex-computers`
- conservative physical CPU, RAM and storage capacity values
- PID limit: `512` (adjust only after review)

The API stores the provider configuration encrypted. Run the host health/discovery action and confirm a real Docker version, CPU/RAM totals, managed running/stopped counts, and `HEALTHY` status. Do not use `tcp://0.0.0.0:2375` or another unauthenticated Docker endpoint.

### 5. Restart and verify services

```sh
sudo systemctl restart <api-service-name> <worker-service-name>
curl --fail https://vm.dolaline.site/health
curl --fail https://vm.dolaline.site/ready
sudo journalctl -u <worker-service-name> -n 100 --no-pager
```

`/ready` must show PostgreSQL, Redis and worker as healthy, plus a healthy Docker provider. An absent Proxmox provider does not make the control plane unready.

### 6. Provision and validate the first AI Computer

1. In the user console, select **XDIGITEX Ubuntu Agent**, a plan, and `local-1`.
2. Confirm the job progresses `CREATING → PROVISIONING → RUNNING`.
3. On the host, run `sudo docker ps --filter label=xdigitex.managed=true`. Inspect the container and verify `Privileged=false`, `ReadonlyRootfs=true`, all capabilities dropped, `NanoCpus`, `Memory`, `MemorySwap`, `PidsLimit`, no published ports, and only the `/workspace` named volume.
4. Use the authenticated command endpoint to write a marker under `/workspace`. Stop and start the AI Computer, then read the marker and confirm persistence.
5. Confirm CPU, memory and network metrics appear from Docker stats. Exercise load inside the computer and verify Docker enforces CPU/RAM limits.
6. Confirm an ordinary user cannot read, start, stop, execute in or delete another organization's computer.
7. Delete the test computer and verify both its managed container and workspace volume are removed. Unknown/orphan resources must only be reported by reconciliation, never automatically removed.

### 7. Moving a workload to Proxmox later

Docker and Proxmox hosts coexist behind the provider interface. Register the Proxmox host and a compatible image, then create new AI Computers on that provider/region. Live cross-provider migration is not implemented: copy `/workspace` through an authorized export/import workflow, verify it, and delete the original only after acceptance. Existing Docker computers remain Docker-backed for their lifetime.

## Rollback

Keep the previous application build and a pre-migration database backup. Stop new workers before rollback so an older worker cannot consume new job formats. Database migration rollback requires an explicitly reviewed forward-fix or restoration plan; never improvise destructive schema changes.
