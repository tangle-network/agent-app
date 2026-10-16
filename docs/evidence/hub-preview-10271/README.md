# Held effect preview proof

Source: `62936732fe423109e5cd8a93356b11567c8c5902`; 2026-10-16. Built shared React components, real HTTP and SQLite fixture storage, Chromium at desktop and phone widths.

[Open the evidence page](index.html). [Uncut scoring/edit/save/reopen recording](page@241b7337887d2e44798d4df6b1d18bbe.webm). [Machine report](report.json).

Nine browser checks passed with zero external requests and zero live-decision calls. They cover initially unset feedback, HTML links and active content isolation, stored scores and edits, failed-save retention, score bounds, phone layout, separate unsaved drafts, save navigation locks, delayed host readback, and inert plain-text/post links. The deliberately removed feedback callback fails the same harness. The first candidate failed because the provider mark fetched a CDN logo; the implementation now draws a local mark.

This is a local fixture demonstration of Drew-style review, not Drew's ratings, a real-inbox fidelity judgment or a deployed GTM journey. No prior-surface browser capture was retained. GTM owns authenticated outcome signals, exact turn/profile/prompt provenance, the immutable Vault batch importer and served consumer proof.

Run after the normal frozen install/build:

```sh
pnpm typecheck
node scripts/prove-hub-preview.mjs --output ~/reviews/hub-preview
node scripts/prove-hub-preview.mjs --fault-no-feedback --output ~/reviews/hub-preview-calibration
```

The normal run exits zero; the intentional calibration run exits one. No provider credentials or model calls are involved. Images are synthetic fixture artifacts and safe to share.
