---
"@tangle-network/agent-app": patch
---

`approvalEmail` takes an `approveUrl` and `denyUrl` per action and renders them as that action's own Approve and Deny links. With one action that has its own approve link, the Approve button opens it. `EmailItem` gains `links` for rows with their own actions. The links must open a confirmation page that decides only on its POST, because link scanners open every link in an email.
