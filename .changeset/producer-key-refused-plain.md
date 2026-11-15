---
'@tangle-network/agent-app': patch
---

The sandbox producer now says a harness's refused model key ("Invalid API key", OpenCode's OPENCODE_ERROR) in plain words, with the typed code `model.key_refused`. The person sees "The assistant is still starting: its model refused the first call. Send your message again in a minute.", followed by the error for support. The turn-health sweep counts this reply as a failed turn.
