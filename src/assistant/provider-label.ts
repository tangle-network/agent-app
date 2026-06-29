/**
 * Display label for a connector slug ("github" → "GitHub"). Kept in its own
 * module — separate from the graph model — so consumers in the always-loaded app
 * shell (e.g. ProposalIntegrations) can import the label without pulling the
 * `yaml` parser (a `model.ts` dependency) into the main bundle.
 */

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  slack: "Slack",
  stripe: "Stripe",
  notion: "Notion",
  linear: "Linear",
  discord: "Discord",
};

export function providerLabel(provider: string): string {
  const key = provider.toLowerCase();
  return (
    PROVIDER_LABELS[key] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
  );
}
