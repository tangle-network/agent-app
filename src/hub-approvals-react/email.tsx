import { useEffect, useState } from 'react'
import type { HubActionPreview } from '../hub-approvals'

type Email = Extract<HubActionPreview, { kind: 'email' }>

const EMAIL_TAGS = new Set('a abbr b blockquote br caption center code col colgroup dd del div dl dt em font h1 h2 h3 h4 h5 h6 hr i img li ol p pre s small span strong sub sup table tbody td tfoot th thead tr u ul'.split(' '))
const EMAIL_ATTRIBUTES = new Set('align alt bgcolor border cellpadding cellspacing class color colspan dir face height lang rowspan size style title valign width'.split(' '))

/** Only embedded raster images: opening a preview must not contact a tracking pixel. */
export function embeddedPreviewImage(value: string | undefined): string | undefined {
  return value && /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value) ? value : undefined
}

function emailDocument(body: string): { document: string; text: string } {
  // Template contents are inert, including their resource URLs. DOMParser can fetch
  // images before sanitizing; never attach the untrusted tree to a live document.
  const template = document.createElement('template')
  template.innerHTML = body
  const target = document.createElement('div')
  function copy(source: Node, parent: Node) {
    if (source.nodeType === Node.TEXT_NODE) { parent.appendChild(document.createTextNode(source.textContent ?? '')); return }
    if (!(source instanceof HTMLElement) || !EMAIL_TAGS.has(source.localName)) return
    const element = document.createElement(source.localName)
    for (const attribute of source.attributes) {
      if (EMAIL_ATTRIBUTES.has(attribute.name)) element.setAttribute(attribute.name, attribute.value)
    }
    if (source.localName === 'a') {
      const href = source.getAttribute('href') ?? ''
      if (/^(https?:|mailto:)/i.test(href.trim())) element.setAttribute('href', href)
      // Links keep their real appearance. The sandbox refuses popups/navigation.
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noopener noreferrer')
    }
    if (source.localName === 'img') {
      const image = embeddedPreviewImage(source.getAttribute('src') ?? undefined)
      if (image) element.setAttribute('src', image)
    }
    for (const child of source.childNodes) copy(child, element)
    parent.appendChild(element)
  }
  for (const child of template.content.childNodes) copy(child, target)
  return {
    document: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><style>body{margin:0;padding:16px 20px;color:#202124;background:#fff;font:14px/1.6 Arial,sans-serif;overflow-wrap:anywhere}a{color:#1155cc}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${target.innerHTML}</body></html>`,
    text: target.textContent ?? '',
  }
}

/** Transport-free inbox rendering. No provider SDK, remote images or executable HTML. */
export function EmailPreview({ preview, account }: { preview: Email; account?: string | null }) {
  const [html, setHtml] = useState<{ source: string; document: string; text: string } | null>(null)
  useEffect(() => {
    if (preview.html && preview.body) setHtml({ source: preview.body, ...emailDocument(preview.body) })
    else setHtml(null)
  }, [preview.body, preview.html])
  const sender = preview.from ?? account ?? 'Sender unavailable'
  const mailbox = /^(.*?)\s*<([^>]+)>$/.exec(sender)
  const name = preview.fromName ?? mailbox?.[1]?.replace(/^"|"$/g, '') ?? sender
  const address = mailbox?.[2] ?? sender
  const currentHtml = html?.source === preview.body ? html : null
  const snippet = preview.previewText ?? (preview.html ? currentHtml?.text : preview.body)?.replace(/\s+/g, ' ').trim()
  return (
    <div data-hub-email-preview className="overflow-hidden rounded-lg border border-border bg-white font-[Arial,sans-serif] text-[#202124] [color-scheme:light]">
      <div className="flex min-w-0 items-baseline gap-3 border-b border-[#e8eaed] bg-[#f2f6fc] px-4 py-3 text-sm" aria-label="Inbox preview">
        <span className="max-w-[30%] shrink-0 truncate font-semibold">{name}</span>
        <span className="min-w-0 truncate"><strong>{preview.subject ?? '(no subject)'}</strong>{snippet && <span className="text-[#5f6368]"> — {snippet}</span>}</span>
      </div>
      <div className="px-4 pt-5 sm:px-5">
        <h4 className="break-words text-[22px] font-normal leading-7">{preview.subject ?? (preview.reply ? 'Reply' : '(no subject)')}</h4>
        <div className="mb-4 mt-5 flex items-start gap-3">
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#e8eaed] text-base text-[#5f6368]">{name.charAt(0).toUpperCase()}</span>
          <dl className="min-w-0 space-y-1 text-[13px]">
            <div className="break-words"><dt className="sr-only">From</dt><dd><strong>{name}</strong>{name !== address && <span className="text-[#5f6368]"> &lt;{address}&gt;</span>}</dd></div>
            <div className="break-words text-[#5f6368]"><dt className="inline">To </dt><dd className="inline">{preview.to.join(', ') || 'Recipient unavailable'}</dd></div>
            {preview.cc.length > 0 && <div className="break-words text-[#5f6368]"><dt className="inline">Cc </dt><dd className="inline">{preview.cc.join(', ')}</dd></div>}
          </dl>
        </div>
      </div>
      {preview.html
        ? currentHtml
          ? <iframe title="Email body" sandbox="" referrerPolicy="no-referrer" srcDoc={currentHtml.document} className="h-[360px] w-full border-0 sm:h-[440px]" />
          : <p role="status" className="px-5 pb-5 text-sm">Rendering email…</p>
        : <div className="whitespace-pre-wrap break-words px-4 pb-6 text-[14px] leading-[1.6] sm:px-5">{linkedText(preview.body ?? '')}</div>}
      {preview.bcc.length > 0 && <p className="border-t border-[#e8eaed] px-4 py-2 text-[13px] text-[#5f6368]">Bcc (sender only): {preview.bcc.join(', ')}</p>}
    </div>
  )
}

export function linkedText(value: string) {
  return value.split(/(https?:\/\/[^\s<>"']+)/g).map((part, index) => /^https?:\/\//i.test(part)
    ? <a key={index} href={part} target="_blank" rel="noopener noreferrer" className="text-[#1155cc] underline">{part}</a>
    : part)
}
