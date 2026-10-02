import { readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const directory = resolve(process.argv[2] ?? 'proof/ui/2026-10-02')
const images = readdirSync(directory).filter(name => name.endsWith('.png')).sort()
const clips = [
  ['Studio · uncut original', 'studio-interaction-original.webm'],
  ['Studio · 3× playback', 'studio-interaction-3x.webm'],
  ['Companion · uncut original', 'companion-interaction-original.webm'],
  ['Companion · 3× playback', 'companion-interaction-3x.webm'],
]
const header = '<!doctype html><html><head><meta charset="utf-8"><title>Shared Agent App UI evidence</title><style>body{font:16px system-ui;margin:24px;background:#111;color:#eee}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:24px}img{width:100%;max-height:500px;object-fit:contain;background:#222}a{color:#9dd4ff}video{width:min(100%,1280px)}</style></head><body><h1>Shared Agent App UI evidence</h1><p>Compiled Storybook fixtures on GTR. Source and artifact limits: <a href="README.md">README</a> · <a href="companion-receipt.json">companion receipt</a>.</p><p>Captures identify their layout artifact and publication boundary in the receipts. Fixture interactions do not prove App publication, shell execution, uploads, or generation.</p><p>The user-provided GTM Artifacts baseline has a different consumer and dataset from the new shared companion fixture. The theme defect has a matched OS-light/app-dark before and after sample.</p>'
writeFileSync(`${directory}/index.html`, header + clips.map(([label, path]) => `<h2>${label}</h2><video controls preload="metadata" src="${path}"></video>`).join('') + '<h2>State images</h2><section>' + images.map(name => `<article><p>${name}</p><a href="${name}"><img src="${name}" loading="lazy"></a></article>`).join('') + '</section></body></html>')
