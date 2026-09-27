/**
 * DOCX → plain text, one paragraph per line.
 *
 * The main document part is resolved through the OPC relationship graph
 * (`_rels/.rels` → the `officeDocument` relationship's target) rather than
 * assuming `word/document.xml`, because the part name is a producer's choice,
 * not a constant.
 *
 * WordprocessingML text lives in `<w:t>` runs. Everything else is markup, with
 * four exceptions that carry meaning a reader would otherwise lose: `<w:tab/>`,
 * `<w:br/>`, `<w:cr/>`, and the paragraph boundary `</w:p>`. Two element bodies
 * are deliberately DROPPED — `<w:instrText>` (field instruction codes such as
 * `HYPERLINK "…"`, which are machinery, not prose) and `<w:delText>` (text a
 * tracked-changes revision deleted; extracting it would show a reader words the
 * author removed).
 *
 * One line per paragraph, not blank-line-separated paragraphs: extractors
 * downstream match line-anchored patterns against form and contract text, so a
 * predictable line structure is the useful shape.
 */
import type { DocumentOutcome, DocxExtractionDetail } from './types';
import { type ReadZipEntryOptions } from './zip';
/** Resolve XML character/entity references. Unknown entities are left verbatim
 *  rather than dropped, so nothing silently disappears from a document. */
export declare function decodeXmlEntities(input: string): string;
export interface DocxText {
    readonly text: string;
    readonly paragraphCount: number;
}
/**
 * Walk WordprocessingML and emit its readable text.
 *
 * Hand-scanned rather than regex-split because comments and CDATA sections may
 * contain `>`; a `/<[^>]*>/` scan ends the tag early on the first one and
 * corrupts everything after it.
 */
export declare function wordprocessingXmlToText(xml: string): DocxText;
/**
 * Extract the readable text of a `.docx` / `.docm` package. Every failure names
 * the archive-level cause; a package this cannot read is an error, never an
 * empty document.
 *
 * `zip.maxUncompressedBytes` bounds what each part may expand to. It defaults
 * to the zip reader's own ceiling, which is what keeps a deflate bomb inside a
 * small `.docx` a typed error instead of an out-of-memory crash.
 */
export declare function extractDocxText(bytes: Uint8Array, mediaType: string, zip?: ReadZipEntryOptions): Promise<DocumentOutcome<{
    text: string;
    detail: DocxExtractionDetail;
}>>;
