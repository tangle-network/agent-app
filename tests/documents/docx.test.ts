/**
 * DOCX extraction against real packages: bytes from an independent Office
 * toolchain (pandoc), and hand-built archives that exercise the branches a
 * generated file never reaches — stored entries, a relocated main part, field
 * codes, tracked deletions, and archives that are broken in specific ways.
 */

import { describe, expect, it } from 'vitest'

import { extractDocument, extractDocxText, DOCX_MEDIA_TYPE, wordprocessingXmlToText } from '../../src/documents'
import { buildDocx, buildZip, documentXml, pandocContractDocx, paragraphs } from './fixtures'

describe('DOCX extraction — real package from an independent toolchain', () => {
  it('reads a pandoc-produced contract, preserving its body text', async () => {
    const outcome = await extractDocument(pandocContractDocx(), {
      mediaType: DOCX_MEDIA_TYPE,
      filename: 'contract.docx',
    })
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.format).toBe('docx')
    expect(outcome.value.text).toContain('MASTER SERVICES AGREEMENT')
    expect(outcome.value.text).toContain('Limitation of Liability')
    expect(outcome.value.text).toContain('250,000.00 USD')
    expect(outcome.value.docx?.part).toBe('word/document.xml')
    expect(outcome.value.docx?.paragraphCount).toBeGreaterThan(4)
  })

  it('decodes XML entities rather than leaking markup into the text', async () => {
    const outcome = await extractDocument(pandocContractDocx(), { mediaType: DOCX_MEDIA_TYPE })
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    // The source markdown wrote `&` and `<exclusive>`; both survive as characters.
    expect(outcome.value.text).toContain('Acme Robotics Inc. & Globex Corporation')
    expect(outcome.value.text).toContain('<exclusive>')
    expect(outcome.value.text).not.toContain('&amp;')
    expect(outcome.value.text).not.toContain('&lt;')
  })

  it('keeps paragraphs on separate lines', async () => {
    const outcome = await extractDocument(pandocContractDocx(), { mediaType: DOCX_MEDIA_TYPE })
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    const lines = outcome.value.text.split('\n').filter((line) => line.trim().length > 0)
    expect(lines[0]).toBe('MASTER SERVICES AGREEMENT')
    expect(lines.some((line) => line.startsWith('Limitation of Liability'))).toBe(true)
  })
})

describe('DOCX extraction — archive branches', () => {
  it('reads a deflated package', async () => {
    const bytes = buildDocx(paragraphs(['First clause.', 'Second clause.']))
    const outcome = await extractDocxText(bytes, DOCX_MEDIA_TYPE)
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.text.trim()).toBe('First clause.\nSecond clause.')
    expect(outcome.value.detail.paragraphCount).toBe(2)
  })

  it('reads a stored (uncompressed) main part', async () => {
    const bytes = buildDocx(paragraphs(['Stored clause.']), { stored: true })
    const outcome = await extractDocxText(bytes, DOCX_MEDIA_TYPE)
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.text.trim()).toBe('Stored clause.')
  })

  it('follows the OPC relationship to a main part that is not word/document.xml', async () => {
    const bytes = buildDocx(paragraphs(['Relocated body.']), { part: 'word/main-body.xml' })
    const outcome = await extractDocxText(bytes, DOCX_MEDIA_TYPE)
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.detail.part).toBe('word/main-body.xml')
    expect(outcome.value.text.trim()).toBe('Relocated body.')
  })

  it('accepts an absolute relationship target', async () => {
    const bytes = buildDocx(paragraphs(['Absolute target.']), {
      relsXml: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document.xml"/></Relationships>`,
    })
    const outcome = await extractDocxText(bytes, DOCX_MEDIA_TYPE)
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.detail.part).toBe('word/document.xml')
  })
})

describe('DOCX extraction — loud failures', () => {
  it('names the missing relationships part rather than returning empty text', async () => {
    const bytes = buildDocx(paragraphs(['Body.']), { omitRels: true })
    const outcome = await extractDocxText(bytes, DOCX_MEDIA_TYPE)
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.code).toBe('malformed-archive')
    expect(outcome.error.stage).toBe('extract')
    expect(outcome.error.message).toContain('_rels/.rels')
  })

  it('names a main part the package points at but does not contain', async () => {
    const bytes = buildDocx(paragraphs(['Body.']), {
      relsXml: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/absent.xml"/></Relationships>`,
    })
    const outcome = await extractDocxText(bytes, DOCX_MEDIA_TYPE)
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.message).toContain('word/absent.xml')
  })

  it('rejects bytes that are not a zip at all', async () => {
    const outcome = await extractDocxText(new TextEncoder().encode('this is plain text, not a package'), DOCX_MEDIA_TYPE)
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.code).toBe('malformed-archive')
    expect(outcome.error.message).toContain('end-of-central-directory')
  })

  it('rejects a zip whose officeDocument relationship is absent', async () => {
    const bytes = buildZip([
      {
        name: '_rels/.rels',
        content: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
      },
      { name: 'word/document.xml', content: documentXml(paragraphs(['Unreferenced.'])) },
    ])
    const outcome = await extractDocxText(bytes, DOCX_MEDIA_TYPE)
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.message).toContain('officeDocument relationship')
  })

  it('reports a package whose body has no text as empty, not as success', async () => {
    const bytes = buildDocx('<w:p/><w:p/>')
    const outcome = await extractDocument(bytes, { mediaType: DOCX_MEDIA_TYPE, filename: 'blank.docx' })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.error.code).toBe('empty-document')
    expect(outcome.error.stage).toBe('extract')
  })
})

describe('WordprocessingML walk', () => {
  it('renders tabs, breaks and paragraph boundaries', () => {
    const walked = wordprocessingXmlToText(
      documentXml(
        '<w:p><w:r><w:t>Term</w:t><w:tab/><w:t>36 months</w:t><w:br/><w:t>renewable</w:t></w:r></w:p><w:p><w:r><w:t>Fee</w:t></w:r></w:p>',
      ),
    )
    expect(walked.text).toBe('Term\t36 months\nrenewable\nFee\n')
    expect(walked.paragraphCount).toBe(2)
  })

  it('drops field instruction codes, which are machinery and not prose', () => {
    const walked = wordprocessingXmlToText(
      documentXml('<w:p><w:r><w:t>See </w:t></w:r><w:r><w:instrText> HYPERLINK "https://example.com" </w:instrText></w:r><w:r><w:t>the terms</w:t></w:r></w:p>'),
    )
    expect(walked.text).toBe('See the terms\n')
    expect(walked.text).not.toContain('HYPERLINK')
  })

  it('drops text a tracked change deleted, and keeps the insertion', () => {
    const walked = wordprocessingXmlToText(
      documentXml(
        '<w:p><w:r><w:t>Fees are </w:t></w:r><w:del><w:r><w:delText>waived</w:delText></w:r></w:del><w:ins><w:r><w:t>due monthly</w:t></w:r></w:ins></w:p>',
      ),
    )
    expect(walked.text).toBe('Fees are due monthly\n')
    expect(walked.text).not.toContain('waived')
  })

  it('preserves significant whitespace inside a run', () => {
    const walked = wordprocessingXmlToText(
      documentXml('<w:p><w:r><w:t xml:space="preserve">This is a</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>real document.</w:t></w:r></w:p>'),
    )
    expect(walked.text).toBe('This is a real document.\n')
  })

  it('resolves named and numeric character references', () => {
    const walked = wordprocessingXmlToText(
      documentXml('<w:p><w:r><w:t>A &amp; B &lt;c&gt; &quot;d&quot; &#8212; &#x2014;</w:t></w:r></w:p>'),
    )
    expect(walked.text).toBe('A & B <c> "d" — —\n')
  })

  it('leaves an unknown entity verbatim instead of silently dropping it', () => {
    const walked = wordprocessingXmlToText(documentXml('<w:p><w:r><w:t>cost &euro;5</w:t></w:r></w:p>'))
    expect(walked.text).toBe('cost &euro;5\n')
  })

  it('survives a comment containing an angle bracket', () => {
    const walked = wordprocessingXmlToText(
      documentXml('<w:p><!-- author note: a > b --><w:r><w:t>Clause one.</w:t></w:r></w:p><w:p><w:r><w:t>Clause two.</w:t></w:r></w:p>'),
    )
    expect(walked.text).toBe('Clause one.\nClause two.\n')
  })

  it('reads text out of a CDATA section', () => {
    const walked = wordprocessingXmlToText(documentXml('<w:p><w:r><w:t><![CDATA[raw <not a tag> text]]></w:t></w:r></w:p>'))
    expect(walked.text).toBe('raw <not a tag> text\n')
  })

  it('emits nothing for markup outside a text run', () => {
    const walked = wordprocessingXmlToText(
      documentXml('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Heading</w:t></w:r></w:p>'),
    )
    expect(walked.text).toBe('Heading\n')
  })
})
