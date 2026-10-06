---
"@tangle-network/agent-app": patch
---

Stop emitting role-named model fields (`modelId`, `provider`, `apiKey`, `baseUrl`) beside the nested `model` object on sandbox backends. A sandbox SDK below 0.60.16 forwards the backend unchanged and the platform refuses the extra keys ("unrecognized_keys … at path backend"), which failed every sandbox chat turn for products on agent-app 0.53.10–0.54.0 with such an SDK. The nested object is the spelling every admitted SDK accepts; the role-named fields return once the sandbox peer floor reaches the fold.
