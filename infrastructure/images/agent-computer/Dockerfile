# XDIGITEX Agent Computer - live XFCE desktop image.
#
# Extends the maintained Playwright/Ubuntu 24.04 base so the image keeps Node.js 22,
# Python and the full Chromium + Playwright browser dependency set, and adds a real
# X11 desktop (Xvfb + XFCE), a loopback-only VNC server (x11vnc) and noVNC/websockify
# so the screen can be streamed to the browser.
FROM mcr.microsoft.com/playwright:v1.52.0-noble

ARG DEBIAN_FRONTEND=noninteractive
ARG AGENT_UID=10001
ARG AGENT_GID=10001

ENV TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOME=/home/agent \
    DISPLAY=:1 \
    XDG_RUNTIME_DIR=/run/user/10001 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    XDIGITEX_GEOMETRY=1440x900 \
    XDIGITEX_VNC_PORT=5901 \
    XDIGITEX_DESKTOP_PORT=6080 \
    XDIGITEX_CDP_PORT=9222

# Desktop stack: X server, window manager + session, VNC, noVNC/websockify, automation
# tooling (xdotool) and screenshot tooling (ImageMagick).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl git jq less nano openssh-client procps psmisc \
      python3 python3-pip python3-venv unzip wget xz-utils zip \
      iproute2 net-tools iputils-ping dnsutils locales tzdata \
      dbus dbus-x11 xdg-utils shared-mime-info hicolor-icon-theme adwaita-icon-theme \
      xvfb x11vnc x11-utils x11-xserver-utils \
      novnc websockify \
      xdotool imagemagick \
      xfce4 xfce4-session xfce4-settings xfce4-panel xfce4-appfinder xfce4-taskmanager \
      xfwm4 xfdesktop4 xfconf thunar xfce4-terminal \
      libgl1 libglx-mesa0 libegl1 libgles2 libgbm1 libglu1-mesa mesa-utils \
      fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji fontconfig \
 && sed -i 's/^# *en_US\.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen \
 && fc-cache -f \
 && dbus-uuidgen > /etc/machine-id \
 && rm -rf /var/lib/apt/lists/*

# The unprivileged agent account owns the persistent home that is mounted as a volume.
RUN set -eux; \
    if ! getent group agent >/dev/null; then groupadd --gid "${AGENT_GID}" agent; fi; \
    if ! id -u agent >/dev/null 2>&1; then \
      useradd --uid "${AGENT_UID}" --gid "${AGENT_GID}" --create-home --shell /bin/bash agent; \
    fi; \
    mkdir -p \
      /home/agent/Desktop \
      /home/agent/Documents \
      /home/agent/Downloads \
      /home/agent/.xdigitex \
      /home/agent/.config/chromium-agent; \
    chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent

# Playwright ships Chromium under /ms-playwright; expose it as a normal desktop browser.
RUN set -eux; \
    CHROME="$(find /ms-playwright -type f -path '*/chrome-linux/chrome' | head -n1)"; \
    test -n "${CHROME}"; \
    ln -sf "${CHROME}" /usr/local/bin/chromium; \
    ln -sf "${CHROME}" /usr/local/bin/chromium-browser; \
    "${CHROME}" --version

COPY xdigitex-desktop /usr/local/bin/xdigitex-desktop
COPY xdigitex-browser /usr/local/bin/xdigitex-browser
COPY xdigitex-browser.desktop /etc/xdg/autostart/xdigitex-browser.desktop
RUN chmod 0755 /usr/local/bin/xdigitex-desktop /usr/local/bin/xdigitex-browser

# /home/agent is the persistent workspace: browser profile, downloads, cookies and files.
VOLUME ["/home/agent"]

USER agent
WORKDIR /home/agent

# noVNC is served by websockify from inside the container; the container publishes no ports.
EXPOSE 6080 9222

CMD ["/usr/local/bin/xdigitex-desktop"]
