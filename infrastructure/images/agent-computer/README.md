# XDIGITEX AI Computer image

Build from the repository root:

```sh
docker build -t xdigitex/agent-computer:2026.09 infrastructure/images/agent-computer
```

The image uses an Ubuntu 24.04 (Noble) Playwright base with Chromium, Node.js and browser
dependencies, then adds Python, Git and common command-line tools. On top of that it ships a
real, headful desktop:

- Xvfb at **1440x900** with an **XFCE** session (`startxfce4`), a terminal (`xfce4-terminal`)
  and a file manager (`thunar`)
- a VNC server (`x11vnc`) bound to the container's **loopback only**
- **noVNC + websockify**, serving the screen and RFB proxy on the container's desktop port
- **Chromium** running visibly inside the XFCE session (`/usr/local/bin/xdigitex-browser`) with
  the DevTools protocol on the container's loopback, and a profile under `/home/agent`
- automation and capture tools: `xdotool` for real X11 input, ImageMagick for screenshots

`/usr/local/bin/xdigitex-desktop` is the entry point (PID 1). It supervises the whole session and
restarts it when a component dies or when `/home/agent/.xdigitex/.session-restart` appears, which
is what the `restart` desktop action touches.

Workloads run as UID/GID 10001 (`agent`) with **`/home/agent` as the persistent volume** — browser
profile, cookies, downloads, repositories and files all live there, so stop/start preserves them
and only an explicit delete removes the volume.

The image publishes **no ports**. The control plane authenticates the caller, verifies ownership
and then bridges the browser's WebSocket to the container's noVNC port over the managed Docker
network. Publish immutable production tags by digest; never use an unreviewed user-supplied image.
