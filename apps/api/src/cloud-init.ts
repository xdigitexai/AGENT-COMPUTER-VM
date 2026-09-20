export function cloudInit(input:{hostname:string;sshPublicKey?:string;agentApiUrl?:string}){
  const lines=["#cloud-config",`hostname: ${input.hostname}`,"manage_etc_hosts: true","users:","  - name: agent","    groups: [sudo]","    sudo: ALL=(ALL) NOPASSWD:ALL","    shell: /bin/bash","    lock_passwd: true"];
  if(input.sshPublicKey)lines.push("    ssh_authorized_keys:",`      - ${JSON.stringify(input.sshPublicKey)}`);
  lines.push("package_update: true","packages:","  - qemu-guest-agent","runcmd:","  - [systemctl, enable, --now, qemu-guest-agent]");
  if(input.agentApiUrl)lines.push(`write_files:\n  - path: /etc/xdigitex-agent.conf\n    permissions: '0600'\n    content: |\n      control_plane=${input.agentApiUrl}`);
  return lines.join("\n");
}
