import type { DownloadGenerations } from '../studio/ports';
/** Same-origin anchor download, staggered so the browser does not swallow
 *  every request after the first. Default when no `download` port is given. */
export declare const downloadGenerationsViaAnchor: DownloadGenerations;
