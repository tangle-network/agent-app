/**
 * Display label for a connector slug ("github" → "GitHub"). Kept in its own
 * module — separate from the graph model — so consumers in the always-loaded app
 * shell (e.g. ProposalIntegrations) can import the label without pulling the
 * `yaml` parser (a `model.ts` dependency) into the main bundle.
 */
export declare function providerLabel(provider: string): string;
