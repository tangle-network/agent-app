/** Relative time label from an epoch-ms timestamp ("just now", "5m ago", "3h
 *  ago", "6d ago", "Mar 3"). Self-contained so the assistant subpath carries no
 *  design-system dep. Buckets stop at weeks; past ~a month the short locale date
 *  is more useful than "11w ago" — the year rides along only when it isn't the
 *  current one. */
export declare function timeAgo(ts: number): string;
