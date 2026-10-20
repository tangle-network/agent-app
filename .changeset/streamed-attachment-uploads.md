---
"@tangle-network/agent-app": patch
---

`createAttachmentUploadRoute` takes one raw file body as well as a form: the bytes as the request body, the name in the `filename` query parameter and the size in `Content-Length` or `X-Upload-Length`. With the new `writeAttachmentStream` writer, a raw body larger than 64 KiB streams to the store while the route checks it: `createStreamingSniffer` (`/chat-routes`) classifies the file from its first 64 KiB and last 1 MiB plus a UTF-8 and NUL check over every byte, and the route withholds the last chunk until the type, kind and size gates pass, so a refused file never reaches the store whole. `limits.maxFormBytes` caps form bodies, which parse whole. The composer hook gains `uploadBody: 'raw'`, `allowedSniffedMimes` and `limits.maxBytesBySniffedMime` to match a route configured that way, and operator adapters gain `maxAttachments` so a turn can carry as many files as the app's chat route admits. Defaults are unchanged.
