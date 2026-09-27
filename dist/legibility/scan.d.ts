/**
 * Filesystem side of the gate: walk a product's source, lex each file once, and
 * hand every check the same `ScannedFile`.
 *
 * Test files are excluded by default and that exclusion is load-bearing, not
 * tidiness: a test fixture deliberately contains the copy and the shapes the
 * checks hunt for ("No results", a silent catch, the word `payload`), so
 * scanning tests would make the gate loudest exactly where nothing ships.
 */
import { type ScannedSource, type SourcePosition } from './source';
/** One file, lexed once, with its line index ready. */
export interface ScannedFile {
    /** Absolute path as walked. */
    readonly path: string;
    /** Path as reported in findings — relative to cwd when it is inside it. */
    readonly display: string;
    readonly text: string;
    readonly scan: ScannedSource;
    readonly lineStarts: readonly number[];
    positionAt(offset: number): SourcePosition;
}
/** Read and lex one file. Returns null when it cannot be read. */
export declare function scanFile(path: string): ScannedFile | null;
/** Lex an in-memory source — the shape every check test uses. */
export declare function buildScannedFile(path: string, text: string): ScannedFile;
/** Lex every scannable file under `srcDirs`. */
export declare function scanSources(srcDirs: readonly string[], ignore?: readonly string[]): ScannedFile[];
/** One readable line of evidence: collapsed whitespace, clipped. */
export declare function evidenceOf(text: string, start: number, end: number, max?: number): string;
