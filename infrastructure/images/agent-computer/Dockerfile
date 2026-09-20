FROM mcr.microsoft.com/playwright:v1.52.0-noble

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl git jq openssh-client \
      python3 python3-pip unzip wget xz-utils zip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash agent \
    && mkdir -p /workspace \
    && chown agent:agent /workspace

ENV HOME=/home/agent \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production
WORKDIR /workspace
VOLUME ["/workspace"]
USER agent
CMD ["/bin/sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"]
