# Build only after the owning package PRs have been released to the registry.
# TANGLE_BASE_IMAGE must be a pinned Tangle sandbox image with its normal
# sidecar/entrypoint, Node >=22, Python 3, Git, Chromium and computer-use support.
# This recipe deliberately supplies no fallback base, floating release tag,
# provider credential, control-plane API key, or runtime open-egress setting.
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
    command -v python3; command -v git; \
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
    test -f node_modules/@tangle-network/agent-app/bin/tangle-agent.mjs; \
    chown -R root:root /opt/tangle-agent; \
    chmod -R go-w /opt/tangle-agent

ENV PATH="/opt/tangle-agent/node_modules/.bin:${PATH}"
# Preserve the Tangle base image's entrypoint/CMD and its non-root runtime user.
# Router credentials, DISPLAY, browser proxy and per-actor product secret refs
# are supplied by the platform at runtime, never embedded in this image.
USER ${TANGLE_RUNTIME_USER}
WORKDIR /home/${TANGLE_RUNTIME_USER}
