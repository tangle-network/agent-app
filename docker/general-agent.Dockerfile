# The operator supplies a digest-pinned Tangle sandbox image with computer_use.
ARG TANGLE_BASE_IMAGE
FROM ${TANGLE_BASE_IMAGE}
USER root
ARG AGENT_APP_VERSION
RUN test -n "$AGENT_APP_VERSION" && mkdir -p /opt/tangle-agent \
    && cd /opt/tangle-agent \
    && npm init --yes >/dev/null \
    && npm install --save-exact --ignore-scripts "@tangle-network/agent-app@$AGENT_APP_VERSION" \
    && npm exec -- playwright install --with-deps chromium \
    && test -f node_modules/@tangle-network/agent-app/dist/general-agent/server.js \
    && chmod -R a+rX /opt/tangle-agent
USER agent
# Runtime package installation is forbidden: the deployed box has strict egress.
