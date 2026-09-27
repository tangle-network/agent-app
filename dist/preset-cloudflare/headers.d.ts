/** One path rule in Cloudflare's static-asset `_headers` file. */
export interface CloudflareHeadersRule {
    pattern: string;
    headers: Readonly<Record<string, string>>;
}
/**
 * Render native Cloudflare static-asset header rules.
 *
 * Values are validated before serialization so a product setting cannot add a
 * second path rule or response header through a newline.
 */
export declare function renderCloudflareHeadersFile(rules: readonly CloudflareHeadersRule[]): string;
