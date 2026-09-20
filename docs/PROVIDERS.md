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
