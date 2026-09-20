# Providers

`VirtualizationProvider` is defined in `apps/api/src/providers/types.ts`. New providers implement the full interface and are selected in `factory.ts`.

## Proxmox VE

The initial provider calls the Proxmox VE REST API for QEMU virtual machines. It supports VM creation, start, graceful shutdown, reboot, suspend/resume, deletion, status, metrics, snapshots, resize, capacity, health, and VNC proxy ticket creation.

Register a host through the admin API with:

- API endpoint, for example `https://pve.example:8006`
- node and region
- CPU, RAM and storage capacity
- API token ID and secret
- storage pool and network bridge

Create a least-privilege Proxmox role covering VM allocate/config/power/monitor/snapshot and datastore allocation on the intended pool and node. Never use the root password. The credential JSON is encrypted before storage and never returned from any API.

The Proxmox host must have a cloud-init capable Ubuntu template. Store its numeric template VMID in `ComputerImage.providerImageId`. The provider performs a full clone, waits for the Proxmox task, applies CPU, memory, DHCP, SSH key and QEMU guest-agent settings, resizes `scsi0`, and only then starts the instance. The seed uses VMID `9000` as an example; change it to the deployed template ID before accepting traffic.

TLS verification should use a certificate trusted by the application host. Provider failures are normalized to safe codes. Operations that may partially succeed are reconciled against the provider before manual retry.

## Docker Engine

`DockerProvider` supports local Unix/named-pipe sockets and Docker Engine HTTP(S) endpoints. Production should prefer the local Unix socket or mutually authenticated TLS; never expose an unauthenticated TCP daemon. It creates only admin-approved images and identifies resources with `xdigitex.managed`, computer, owner and organization labels. Operations verify those labels before acting, so arbitrary host containers cannot be targeted.

Each AI Computer receives a named `/workspace` volume, a dedicated `xdigitex-computers` bridge, CPU (`NanoCpus`), memory/memory-swap, and PID limits. Containers are never privileged, drop all Linux capabilities, enable `no-new-privileges`, use a read-only base filesystem, run as the `agent` user, receive bounded tmpfs mounts, and never mount the Docker socket or host files. No ports are published by default.

Docker capabilities are create, start, stop, restart, pause/resume, real stats, authenticated exec, persistent storage and CPU/RAM resize. VM-style snapshots and console tickets explicitly return `CAPABILITY_UNSUPPORTED`. Default local volumes do not provide a portable hard byte quota; the requested storage allocation is enforced by scheduler capacity and metering. Deploy a quota-capable Docker volume driver/filesystem before selling hard per-workspace disk limits.

The maintained image is in `infrastructure/images/agent-computer`. It uses an Ubuntu Noble Playwright base so Chromium, Node.js and browser dependencies are real, then adds Python, Git and common tools. Browser control endpoints remain a separate permission-scoped integration.
