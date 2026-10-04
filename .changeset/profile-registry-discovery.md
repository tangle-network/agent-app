---
"@tangle-network/agent-app": minor
---

Add registry discovery to the exported `AgentProfileEditor` (agent-app#776): a host-supplied `AgentProfileRegistryPort` searches maintained skill catalogs and the official MCP Registry or custom registries from the Skills and MCP sections. Results show the answering catalog, purpose, source, and declared permissions before the operator adds them; adding only places the canonical reference in the profile draft, and the product's own constraints (unique skill names, pinned commit SHAs, public HTTPS endpoints) still decide what may be added. Search renders concise searching, empty, unavailable-catalog, authorization-required, and failure states without fabricating matches. Custom skill references, MCP endpoints, tools, and resources remain first-class.
