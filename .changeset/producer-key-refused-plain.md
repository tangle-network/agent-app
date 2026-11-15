---
'@tangle-network/agent-app': patch
---

The sandbox producer now says a harness's refused model key ("Invalid API key", OpenCode's OPENCODE_ERROR) in plain words, with the typed code `model.key_refused`. The person sees "The assistant's model refused its access key, so this message was not answered. If the assistant has just started, send it again in a minute; if this repeats, tell the team." The raw error goes to the log and the failure note only. The turn-health sweep counts this reply as a failed turn.
