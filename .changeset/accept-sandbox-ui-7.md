---
"@tangle-network/agent-app": patch
---

Accept `@tangle-network/sandbox-ui` 7.0.5 as the peer. Every one of the 34 names agent-app imports from its eight sandbox-ui subpaths (primitives, workspace, dashboard, chat, vault-tree, integrations, workbench, markdown) is exported by 7.0.5, checked against its source; the 3.0 to 7.0 breaks are in the run, record and terminal entries agent-app does not import. 7.0.5 is the release whose run entry carries `AgentWorkspace` and the grid `TraceWorkspace`, which disco.tangle.tools (tangle-network/disco-app) draws beside this shell's `AgentWorkspaceLayout`; with the old range its install stops at `ERR_PNPM_PEER_DEP_ISSUES` and `agent-app-peer-check` reads 7.0.5 as below the floor.
