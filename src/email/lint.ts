/** One way an email's HTML would break in Gmail or Outlook. */
export interface EmailLintIssue {
  rule:
    | 'document'
    | 'external-css'
    | 'style-block'
    | 'unsupported-element'
    | 'unsupported-css'
    | 'layout-table'
    | 'inline-style'
    | 'image'
    | 'link'
    | 'size'
  message: string
}

// Gmail clips a message body larger than about 102 KB behind "View entire message".
const GMAIL_CLIP_BYTES = 102_000

const tags = (html: string, name: string): string[] =>
  html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? []

const attribute = (tag: string, name: string): string | null => {
  const match = new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)
  return match ? match[1]! : null
}

/** Top-level rules of a stylesheet: their selector or at-rule preludes. */
function preludes(css: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth === 0) out.push(css.slice(start, i).trim())
      depth++
    } else if (css[i] === '}') {
      depth--
      if (depth === 0) start = i + 1
    }
  }
  return out
}

/**
 * Check rendered email HTML against what Gmail and Outlook render: a complete
 * document, layout in presentation tables, styles inline (a `<style>` block may
 * only add dark-mode and narrow-screen overrides), images with alt text and
 * fixed size, absolute links, and a body small enough that Gmail does not clip.
 */
export function lintEmailHtml(html: string): EmailLintIssue[] {
  const issues: EmailLintIssue[] = []
  const issue = (rule: EmailLintIssue['rule'], message: string) => issues.push({ rule, message })
  const visible = html.replace(/<!--[\s\S]*?-->/g, '')

  if (!/^<!DOCTYPE html>/i.test(html)) issue('document', 'Missing <!DOCTYPE html>')
  if (!/<html\b[^>]*\slang="[^"]+"/i.test(html)) issue('document', 'Missing <html lang>')
  if (!/<meta charset="utf-8">/i.test(html)) issue('document', 'Missing <meta charset="utf-8">')
  if (!/<title>[^<]+<\/title>/i.test(html)) issue('document', 'Missing <title>')

  if (/<link\b[^>]*rel="?stylesheet/i.test(visible)) issue('external-css', 'Linked stylesheets are stripped')
  if (/@import\b/i.test(visible)) issue('external-css', '@import is stripped')

  for (const block of visible.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) ?? []) {
    const css = block.replace(/<\/?style\b[^>]*>/gi, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const prelude of preludes(css)) {
      if (!prelude.startsWith('@media') && !prelude.startsWith('[data-og')) {
        issue('style-block', `<style> may only hold overrides; "${prelude}" must be inline`)
      }
    }
  }

  for (const name of ['script', 'form', 'input', 'button', 'svg', 'iframe', 'video', 'audio', 'object', 'embed']) {
    if (tags(visible, name).length > 0) issue('unsupported-element', `<${name}> is stripped or unsupported`)
  }

  for (const pattern of [
    /display\s*:\s*(?:flex|grid|inline-flex)/i,
    /position\s*:/i,
    /float\s*:/i,
    /var\(/i,
    /calc\(/i,
    /rgba?\(|hsla?\(/i,
    /background-image\s*:|url\(/i,
  ]) {
    if (pattern.test(visible)) issue('unsupported-css', `Outlook does not render ${pattern.source}`)
  }

  for (const table of tags(visible, 'table')) {
    if (attribute(table, 'role') !== 'presentation') issue('layout-table', `Layout table without role="presentation": ${table.slice(0, 80)}`)
    for (const name of ['cellpadding', 'cellspacing', 'border']) {
      if (attribute(table, name) !== '0') issue('layout-table', `Layout table without ${name}="0": ${table.slice(0, 80)}`)
    }
  }
  for (const div of tags(visible, 'div')) {
    const style = attribute(div, 'style') ?? ''
    if (!/display\s*:\s*none/i.test(style) && /(?:^|;)\s*(?:max-)?width\s*:/i.test(style)) {
      issue('layout-table', 'Outlook ignores <div> widths; size with a table cell')
    }
  }

  for (const name of ['p', 'h1', 'h2', 'h3', 'a', 'span']) {
    for (const tag of tags(visible, name)) {
      const style = attribute(tag, 'style') ?? ''
      if (!/(?:^|;)\s*color\s*:/i.test(style) || !/font-(?:family|size)\s*:/i.test(style) && name !== 'a') {
        issue('inline-style', `<${name}> without inline color and font: ${tag.slice(0, 80)}`)
      }
    }
  }

  for (const img of tags(visible, 'img')) {
    if (!attribute(img, 'alt')) issue('image', `Image without alt text: ${img.slice(0, 80)}`)
    if (!attribute(img, 'width') || !attribute(img, 'height')) issue('image', `Image without width and height: ${img.slice(0, 80)}`)
    const src = attribute(img, 'src') ?? ''
    if (!/^(?:https:|cid:)/.test(src)) issue('image', `Image source must be https: or cid: (${src.slice(0, 40)})`)
  }

  for (const anchor of tags(visible, 'a')) {
    const href = attribute(anchor, 'href') ?? ''
    if (!/^(?:https:\/\/|mailto:|http:\/\/(?:localhost|127\.0\.0\.1)[:/])/.test(href)) {
      issue('link', `Links must be absolute https: ${href.slice(0, 60)}`)
    }
  }

  const bytes = new TextEncoder().encode(html).length
  if (bytes > GMAIL_CLIP_BYTES) issue('size', `${bytes} bytes; Gmail clips above ${GMAIL_CLIP_BYTES}`)
  return issues
}
