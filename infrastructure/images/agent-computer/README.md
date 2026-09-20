# XDIGITEX AI Computer image

Build from the repository root:

```sh
docker build -t xdigitex/agent-computer:2026.09 infrastructure/images/agent-computer
```

The image uses an Ubuntu 24.04 (Noble) Playwright base with Chromium, Node.js and browser dependencies, then adds Python, Git and common command-line tools. Workloads run as UID/GID 10001 (`agent`) with `/workspace` as the persistent volume. Publish immutable production tags by digest; never use an unreviewed user-supplied image.
