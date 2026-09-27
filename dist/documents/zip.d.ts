/**
 * The slice of PKZIP an OOXML package needs: read the central directory, then
 * inflate one named entry.
 *
 * Why not a zip library: DOCX text extraction is the only reason this module
 * needs a zip, and the runtime already supplies the hard part —
 * `DecompressionStream('deflate-raw')` is a standard API present in workerd
 * and in Node, so the whole reader is header arithmetic plus a stream. Pulling
 * a zip package in would put ten transitive Node-shaped dependencies into every
 * consumer's Worker bundle to avoid ~120 lines.
 *
 * The CENTRAL DIRECTORY is the source of truth, not the local headers: an
 * archive written with data descriptors (streamed output) carries zeros for
 * the sizes in its local headers, and reading those is the classic way a
 * hand-rolled zip reader silently returns nothing.
 */
export type ZipOutcome<T> = {
    succeeded: true;
    value: T;
} | {
    succeeded: false;
    error: string;
};
export interface ZipEntry {
    readonly name: string;
    readonly compressionMethod: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly localHeaderOffset: number;
    readonly encrypted: boolean;
}
/** Read every central-directory entry. Names are decoded as UTF-8, which is
 *  what OOXML producers write (general-purpose bit 11). */
export declare function readZipDirectory(bytes: Uint8Array): ZipOutcome<ZipEntry[]>;
/**
 * Ceiling on what ONE entry may expand to. A deflate stream reaches ~1000:1 on
 * repetitive input, so an archive small enough to pass any upload gate can ask
 * for gigabytes: measured here, a 305,893-byte archive declared a single entry
 * expanding to 314,572,800 bytes. A Cloudflare Worker isolate has 128 MB, so
 * that is an out-of-memory crash, not a slow path — and a crash is not a typed
 * error a product can report. 32 MB is far past any real Office part (the main
 * document of a 400-page contract is single-digit MB) and far under the
 * isolate's budget.
 */
export declare const DEFAULT_MAX_ZIP_ENTRY_BYTES: number;
/** Options for {@link readZipEntry}. */
export interface ReadZipEntryOptions {
    /** Ceiling on the entry's UNCOMPRESSED size. Defaults to
     *  {@link DEFAULT_MAX_ZIP_ENTRY_BYTES}. Checked against the directory's
     *  declared size before any inflate runs, and again against the real output
     *  as it streams, because the declared size is the archive's claim. */
    readonly maxUncompressedBytes?: number;
}
/** Inflate one entry's bytes. The local header supplies only the variable-length
 *  field sizes needed to find the payload; sizes come from the directory. */
export declare function readZipEntry(bytes: Uint8Array, entry: ZipEntry, options?: ReadZipEntryOptions): Promise<ZipOutcome<Uint8Array>>;
