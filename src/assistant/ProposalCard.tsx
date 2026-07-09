/**
 * Confirmation card for a mutating action the assistant proposed (create a
 * workflow, author a workflow + skills, run a workflow, manage a key, …). Shows
 * the action heading, its scalar fields, any new skills, a body preview (a
 * workflow renders as a node graph via the injected `renderGraph`, with a YAML
 * toggle; other bodies render verbatim), the integration requirements with a
 * connect affordance, and Confirm/Cancel.
 *
 * The body preview's graph is injected so this card — in the always-loaded
 * `./assistant` entry — doesn't pull the graph's `@xyflow/react` dependency; the
 * host wires `renderGraph` from `./workflows`. Navigation is injected too.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { ProviderLogo } from "../web-react/provider-logo";
import { describeProposal } from "./presentation";
import { providerLabel } from "./provider-label";
import type { ConnectionRequirement, PendingProposal } from "./types";

export interface ProposalCardProps {
  proposal: PendingProposal;
  /** True while this proposal's confirmation is in flight (disables the buttons). */
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Host navigation for connect targets / the integrations page. */
  navigate?: (path: string) => void;
  /** In-place connect handler for a requirement. When provided, a requirement's
   *  connect affordance calls this (showing a busy state) instead of navigating
   *  to `connectUrl`/the integrations page — the host runs its own connect flow
   *  and the card flips the requirement to connected on success. Host-agnostic;
   *  wired by the panel from {@link UseAssistantChatOptions.onConnectRequirement}. */
  onConnect?: (requirement: ConnectionRequirement) => void | Promise<void>;
  /** Render the workflow YAML as a node graph (the `./workflows` WorkflowGraph).
   *  When absent, the YAML is shown as text. */
  renderGraph?: (yaml: string) => ReactNode;
}

export function ProposalCard({
  proposal,
  confirming,
  onConfirm,
  onCancel,
  navigate,
  onConnect,
  renderGraph,
}: ProposalCardProps) {
  const view = describeProposal(proposal);
  const [tab, setTab] = useState<"graph" | "yaml">("graph");
  const isWorkflow = view.preview?.kind === "workflow";
  const showGraph = isWorkflow && !!renderGraph;

  return (
    <div className="rounded-lg border border-primary/40 bg-card p-3 text-sm">
      <p className="font-medium text-foreground">{view.title}</p>
      <p className="text-muted-foreground text-xs">
        Confirm to run this action on your account.
      </p>

      {view.fields.length > 0 && (
        <dl className="mt-2 space-y-1">
          {view.fields.map((f) => (
            <div key={f.label} className="flex gap-2 text-xs">
              <dt className="shrink-0 text-muted-foreground">{f.label}</dt>
              <dd className="truncate text-foreground" title={f.value}>
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {view.skills && view.skills.length > 0 && (
        <div className="mt-2">
          <p className="text-muted-foreground text-xs">New skills</p>
          <ul className="mt-1 space-y-0.5">
            {view.skills.map((s) => (
              <li key={s.name} className="text-foreground text-xs">
                <span className="font-medium">{s.name}</span>
                {s.description ? (
                  <span className="text-muted-foreground"> — {s.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.preview && (
        <div className="mt-2">
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">{view.preview.label}</p>
            {showGraph && (
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setTab("graph")}
                  className={
                    tab === "graph" ? "text-foreground" : "text-muted-foreground"
                  }
                >
                  Graph
                </button>
                <button
                  type="button"
                  onClick={() => setTab("yaml")}
                  className={
                    tab === "yaml" ? "text-foreground" : "text-muted-foreground"
                  }
                >
                  YAML
                </button>
              </div>
            )}
          </div>
          {showGraph && tab === "graph" ? (
            <div className="mt-1 h-64 overflow-hidden rounded border border-border">
              {renderGraph?.(view.preview.content)}
            </div>
          ) : (
            <pre className="mt-1 max-h-48 overflow-auto rounded border border-border bg-muted/50 p-2 text-xs">
              <code>{view.preview.content}</code>
            </pre>
          )}
        </div>
      )}

      {proposal.requirements && proposal.requirements.length > 0 && (
        <div className="mt-3 rounded border border-border p-2">
          <p className="text-muted-foreground text-xs">Integrations</p>
          <ul className="mt-1 space-y-1">
            {proposal.requirements.map((r) => (
              <RequirementRow
                key={`${r.provider}-${r.kind ?? "integration"}`}
                req={r}
                navigate={navigate}
                onConnect={onConnect}
              />
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground text-xs">
            Connect the items above, then confirm — your proposal stays here until
            you do.
          </p>
        </div>
      )}

      {proposal.retryError && (
        <p role="alert" className="mt-2 text-destructive text-xs">
          {proposal.retryError}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirming || !proposal.proposalId}
          className="rounded bg-primary px-3 py-1.5 text-primary-foreground text-sm disabled:opacity-50"
        >
          {confirming ? "Confirming…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={confirming}
          className="rounded border border-border px-3 py-1.5 text-foreground text-sm disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function openConnect(target: string, navigate?: (path: string) => void) {
  // Protocol-relative URLs (//host) inherit the page scheme and point off-site —
  // never a legitimate connect target, so reject outright.
  if (target.startsWith("//")) return;
  // Canonicalize before the scheme check so it can't be smuggled past with
  // leading whitespace or an embedded tab/newline that browsers strip (a regex
  // guard misses those). Only http(s) may EVER navigate — via window.open OR
  // window.location.assign — which closes the `javascript:`/`data:` XSS vector.
  let url: URL;
  try {
    url = new URL(target, window.location.origin);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  // A bare relative path (no scheme) is in-app navigation → host router; an
  // absolute http(s) URL is an external link → new tab.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    window.open(url.href, "_blank", "noopener,noreferrer");
  } else if (navigate) {
    navigate(target);
  } else {
    window.location.assign(url.href);
  }
}

function RequirementRow({
  req,
  navigate,
  onConnect,
}: {
  req: ConnectionRequirement;
  navigate?: (path: string) => void;
  onConnect?: (requirement: ConnectionRequirement) => void | Promise<void>;
}) {
  const [connecting, setConnecting] = useState(false);
  // The connect can outlive the row (the card is resolved/cancelled while the
  // host's connect UI is open), so guard the busy-state reset against a resolve
  // on an unmounted row.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const label = providerLabel(req.provider);
  const isApp = req.kind === "github_app";
  const kindLabel = isApp ? `${label} App` : label;
  const statusText = req.connected
    ? isApp
      ? "installed"
      : "connected"
    : isApp
      ? "not installed"
      : "not connected";
  // A host handler makes the requirement actionable regardless of connectUrl (it
  // owns the connect experience). Without one, `connectUrl === null` means "no
  // connect target to offer" (e.g. a github_app requirement on a deploy with no
  // app slug) — show the status without a link.
  const canConnect =
    !req.connected && (Boolean(onConnect) || req.connectUrl !== null);
  const target = req.connectUrl ?? "/app/integrations";

  // In-place connect when the host wired a handler; otherwise navigate to the
  // requirement's connect target (the legacy, still-supported path for hosts
  // that route the user to their own integrations surface).
  const handleConnect = () => {
    if (!onConnect) {
      openConnect(target, navigate);
      return;
    }
    setConnecting(true);
    // Call synchronously so a host that must open a popup does so inside the user
    // gesture (popup-blocker safe). Contain BOTH a synchronous throw and an async
    // rejection — this is a public prop — so a misbehaving handler can neither
    // leak an unhandled rejection nor wedge the busy state.
    let pending: void | Promise<void>;
    try {
      pending = onConnect(req);
    } catch {
      if (mountedRef.current) setConnecting(false);
      return;
    }
    void Promise.resolve(pending)
      .catch(() => {})
      .finally(() => {
        if (mountedRef.current) setConnecting(false);
      });
  };

  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="flex min-w-0 items-center gap-2">
        <ProviderLogo provider={req.provider} size={16} />
        <span className="truncate text-foreground">{kindLabel}</span>
        <span className="flex shrink-0 items-center gap-1">
          {/* Filled vs outlined dot is a non-color (shape) cue for the
              connected state, so it reads for color-blind users too — the
              status text alone would lean on color. */}
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${
              req.connected ? "bg-primary" : "border border-muted-foreground"
            }`}
          />
          <span
            className={req.connected ? "text-primary" : "text-muted-foreground"}
          >
            {statusText}
          </span>
        </span>
      </span>
      {canConnect && (
        <button
          type="button"
          onClick={handleConnect}
          disabled={connecting}
          className="shrink-0 rounded border border-primary px-2 py-0.5 font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
        >
          {connecting
            ? isApp
              ? "Installing…"
              : "Connecting…"
            : isApp
              ? "Install"
              : "Connect"}
        </button>
      )}
    </li>
  );
}
