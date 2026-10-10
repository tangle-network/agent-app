# Build only after the owning package PRs have been published to the registry.
# The base must be a digest-pinned Tangle image with its normal sidecar,
# Node >=22, Python, Git, sudo, Chromium and virtual-display computer use.
ARG TANGLE_BASE_IMAGE
FROM ${TANGLE_BASE_IMAGE}
ARG TANGLE_RUNTIME_USER
ARG AGENT_APP_VERSION
ARG AGENT_INTEGRATIONS_VERSION
ARG BROWSER_AGENT_VERSION
ARG HUB_SDK_VERSION
ARG TCLOUD_VERSION
ARG PLAYWRIGHT_VERSION
ARG MCP_SDK_VERSION
ARG ANTHROPIC_SDK_VERSION
ARG AI_GOOGLE_VERSION
ARG AI_ANTHROPIC_VERSION

USER root
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /opt/tangle-agent
RUN set -eu; \
    test -n "$TANGLE_RUNTIME_USER"; \
    test "$(id -u "$TANGLE_RUNTIME_USER")" -ne 0; \
    node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'; \
    test -x /usr/bin/python3; test -x /usr/bin/git; \
    test -x /usr/bin/sudo; test -x /usr/sbin/visudo; \
    for version in "$AGENT_APP_VERSION" "$AGENT_INTEGRATIONS_VERSION" "$BROWSER_AGENT_VERSION" \
      "$HUB_SDK_VERSION" "$TCLOUD_VERSION" "$PLAYWRIGHT_VERSION" "$MCP_SDK_VERSION" \
      "$ANTHROPIC_SDK_VERSION" "$AI_GOOGLE_VERSION" "$AI_ANTHROPIC_VERSION"; do \
      printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$'; \
    done; \
    npm init -y; \
    npm install --save-exact --omit=dev \
      "@tangle-network/agent-app@$AGENT_APP_VERSION" \
      "@tangle-network/agent-integrations@$AGENT_INTEGRATIONS_VERSION" \
      "@tangle-network/browser-agent-driver@$BROWSER_AGENT_VERSION" \
      "@tangle-network/hub-sdk@$HUB_SDK_VERSION" \
      "@tangle-network/tcloud@$TCLOUD_VERSION" \
      "playwright@$PLAYWRIGHT_VERSION" \
      "@modelcontextprotocol/sdk@$MCP_SDK_VERSION" \
      "@anthropic-ai/sdk@$ANTHROPIC_SDK_VERSION" \
      "@ai-sdk/google@$AI_GOOGLE_VERSION" \
      "@ai-sdk/anthropic@$AI_ANTHROPIC_VERSION"; \
    npm ls --all --json > package-receipt.json; \
    node --input-type=module -e 'import { TangleReadClient } from "@tangle-network/agent-integrations/tangle-search"; import { TCloud } from "@tangle-network/tcloud"; import { BrowserAgent } from "@tangle-network/browser-agent-driver"; if (![TangleReadClient,TCloud,BrowserAgent].every(x=>typeof x === "function")) process.exit(1)'; \
    test -f node_modules/@tangle-network/agent-app/bin/tangle-agent/home-maintenance.py; \
    chown -R root:root /opt/tangle-agent; \
    chmod -R go-w /opt/tangle-agent; \
    node node_modules/@tangle-network/agent-app/bin/tangle-agent.mjs install-home "$TANGLE_RUNTIME_USER" > home-install-receipt.json

ENV PATH="/opt/tangle-agent/node_modules/.bin:${PATH}"
ENV TANGLE_AGENT_HOME="/var/lib/tangle-agent/home"
# Keep the base image entrypoint/CMD. The actual sidecar and its tools must run
# as this UID with no ambient privilege/capability escalation. initializeHome
# refuses a root/mismatched UID. The normal writable work area is separate from
# the root-owned home and its root-private Git journal. This image has an unbound
# local checkpoint, not proof of remote durability. Trusted per-instance setup
# can bind both directories to its authenticated learning identity before start.
# Snapshot/restore both directories and binding markers together and verify the
# restored identity/checkpoint; a Docker image or matching st_dev is not proof.
USER ${TANGLE_RUNTIME_USER}
WORKDIR /home/${TANGLE_RUNTIME_USER}
