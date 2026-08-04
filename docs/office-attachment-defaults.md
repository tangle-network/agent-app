# Office attachments — what changed in the shipped defaults

Admitting `.docx` / `.xlsx` / `.pptx` through `createAttachmentUploadRoute` is new capability, but it did **not** arrive as a new export a product opts into.
It moved two shipped defaults and one function's output.
This page states exactly what moved so a consumer reading a release note can tell whether it affects them.

**This is a MINOR-version change, not a patch and not a purely additive one.**
No export was removed and no signature changed — the codemap diff across all 88 entries shows zero removed exports and one changed default value — but a pinned consumer that upgrades gets different behavior on the same bytes.

## The three moves

| Symbol | Before | After |
| --- | --- | --- |
| `ATTACHMENT_ACCEPT` | `image/*,.pdf,.txt,.md,.csv,.json,.yaml,.yml,.html` | `image/*,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.yaml,.yml,.html` |
| `ALLOWED_ATTACHMENT_SNIFFED_MIMES` | images + `application/pdf` | the same, plus the three plain OOXML package mimes (`OOXML_SNIFFED_MIMES`) |
| `sniffBinary` on a real `.docx` | `{ binary: true, mime: 'application/zip' }` | `{ binary: true, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }` |

Alongside them, the internal extension→mime table gained `docx`/`xlsx`/`pptx`/`docm`/`xlsm`/`pptm`, so a renamed archive is now reported as a *mismatch that names the real type* instead of a bare 415.

## Who this changes behavior for

**A consumer that passes no `allowedSniffedMimes`** — every consumer in the fleet today (checked: `rg allowedSniffedMimes` across tax-agent, legal-agent, gtm-agent, relationships-agent, insurance-agent, workcomp-agent and creative-agent returns no hits) — begins accepting Office packages on upgrade, with no code change.
That is the intended capability.
It is still worth naming: a product whose store or downstream pipeline assumed "images and PDF only" now receives a third binary class.

**A consumer that spreads the default set** — `new Set([...ALLOWED_ATTACHMENT_SNIFFED_MIMES, …])` — also begins accepting them, for the same reason.

**A consumer with a hand-written allow-list containing `'application/zip'`** — the only way to accept `.docx` before this change, because that is what the container sniffed as — stops accepting Office uploads: the bytes now sniff as an OOXML mime that is not in their set, and the extension check no longer rescues them either.
No such consumer exists in the fleet, which is why the change ships as-is rather than carrying a compatibility rule for a shape nobody wrote.
The fix for one, if it appears, is one line: add `...OOXML_SNIFFED_MIMES` to the set.

## What the gate does and does not prove

`sniffBinary` answers *what format do these bytes claim to be*, from the archive's own uncompressed metadata: the central directory's entry names, plus the content-types part's text in the one case where a producer stored it uncompressed.
It has no inflater by design — it ships into browser bundles and runs on untrusted bytes — so a deflated part's CONTENT is unreadable to it.

Two structural parts are therefore required, not one: `[Content_Types].xml` **and** `_rels/.rels`, the OPC package-relationships part ECMA-376 Part 2 mandates.
A package carrying a `vbaProject.bin` part reports the macro-enabled mime whatever its content-types part declares, and the default allow-list refuses those — opt in through `MACRO_ENABLED_OOXML_SNIFFED_MIMES`.

An archive that names three entries correctly and fills them with arbitrary bytes still reports the Office mime.
That is the same standing every magic-byte family has here — `%PDF-` followed by arbitrary bytes reports `application/pdf` — and no name-only reader can do better.
The gate is a FORMAT gate.
A product that needs the bytes to be a real, parseable document gets that from `/documents`' extractor, which fails loud on a package it cannot read.
