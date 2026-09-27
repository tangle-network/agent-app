// src/teams-react/components/InviteAcceptPage.tsx
import { useState } from "react";

// src/teams-react/components/BrandMark.tsx
import { lazy, Suspense } from "react";
import { jsx } from "react/jsx-runtime";
function MarkSpacer({ size }) {
  return /* @__PURE__ */ jsx("span", { "aria-hidden": true, style: { display: "inline-block", width: size, height: size } });
}
var LazyKnot = lazy(async () => {
  try {
    const mod = await import("./brand/index.js");
    return { default: mod.TangleKnot };
  } catch {
    return { default: MarkSpacer };
  }
});
function BrandMark({ size, className }) {
  return /* @__PURE__ */ jsx(Suspense, { fallback: /* @__PURE__ */ jsx(MarkSpacer, { size }), children: /* @__PURE__ */ jsx(LazyKnot, { size, className }) });
}

// src/teams-react/components/InviteAcceptPage.tsx
import { jsx as jsx2, jsxs } from "react/jsx-runtime";
function InviteAcceptPage({ details, onAccept, onNavigate, onResendVerification }) {
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [resendingVerification, setResendingVerification] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  if (details.status === "invalid") {
    return /* @__PURE__ */ jsx2(Shell, { title: "Invalid invitation", body: "This link is invalid or already used. Ask the workspace admin to send a new one.", children: /* @__PURE__ */ jsx2(PrimaryButton, { onClick: () => onNavigate({ kind: "sign-in" }), children: "Go to sign in" }) });
  }
  if (details.status === "already-accepted") {
    return /* @__PURE__ */ jsx2(Shell, { title: "Already accepted", body: "This invitation has already been accepted.", children: /* @__PURE__ */ jsx2(PrimaryButton, { onClick: () => onNavigate({ kind: "open-app" }), children: "Open workspace" }) });
  }
  if (details.status === "expired") {
    return /* @__PURE__ */ jsx2(Shell, { title: "Invitation expired", body: "This invitation has expired. Ask the workspace admin to send a new one.", children: /* @__PURE__ */ jsx2(PrimaryButton, { onClick: () => onNavigate({ kind: "sign-in" }), children: "Go to sign in" }) });
  }
  if (details.status === "revoked") {
    return /* @__PURE__ */ jsx2(Shell, { title: "Invitation revoked", body: "This invitation has been revoked. Ask the workspace admin to send a new one.", children: /* @__PURE__ */ jsx2(PrimaryButton, { onClick: () => onNavigate({ kind: "sign-in" }), children: "Go to sign in" }) });
  }
  const workspaceName = details.workspaceName ?? "a workspace";
  const inviterPrefix = details.inviterName ? `${details.inviterName} invited you` : "You've been invited";
  const roleSuffix = details.role ? ` as ${details.role}` : "";
  if (!details.currentUserEmail) {
    return /* @__PURE__ */ jsxs(Shell, { title: "You've been invited", children: [
      /* @__PURE__ */ jsxs("p", { className: "mb-4 text-sm text-[var(--text-secondary)]", children: [
        inviterPrefix,
        " to join ",
        /* @__PURE__ */ jsx2("span", { className: "font-medium text-[var(--text-primary)]", children: workspaceName }),
        roleSuffix,
        "."
      ] }),
      details.inviteEmail && /* @__PURE__ */ jsxs("p", { className: "mb-6 text-sm text-[var(--text-secondary)]", children: [
        "Sign in or create an account with",
        " ",
        /* @__PURE__ */ jsx2("span", { className: "font-medium text-[var(--text-primary)]", children: details.inviteEmail }),
        " to accept."
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
        /* @__PURE__ */ jsx2(PrimaryButton, { onClick: () => onNavigate({ kind: "sign-in" }), children: "Sign in" }),
        /* @__PURE__ */ jsx2(SecondaryButton, { onClick: () => onNavigate({ kind: "sign-up" }), children: "Create account" })
      ] })
    ] });
  }
  if (accepted) {
    return /* @__PURE__ */ jsx2(Shell, { title: "Welcome!", children: /* @__PURE__ */ jsxs("p", { className: "text-sm text-[var(--text-secondary)]", children: [
      "You've joined ",
      /* @__PURE__ */ jsx2("span", { className: "font-medium text-[var(--text-primary)]", children: workspaceName }),
      "."
    ] }) });
  }
  const emailMismatch = Boolean(
    details.inviteEmail && details.inviteEmail.toLowerCase() !== details.currentUserEmail.toLowerCase()
  );
  const needsVerification = Boolean(details.needsEmailVerification) && !emailMismatch;
  const expiryLabel = details.expiresAt != null ? new Date(details.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
  async function handleAccept() {
    setAccepting(true);
    setAcceptError(null);
    try {
      const result = await onAccept();
      setAccepted(true);
      if (result && "workspaceId" in result && result.workspaceId) {
        onNavigate({ kind: "open-app", workspaceId: result.workspaceId });
      }
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : "Failed to accept invitation");
    } finally {
      setAccepting(false);
    }
  }
  async function handleResendVerification() {
    if (!onResendVerification || resendingVerification) return;
    setResendingVerification(true);
    try {
      await onResendVerification();
      setVerificationSent(true);
    } finally {
      setResendingVerification(false);
    }
  }
  return /* @__PURE__ */ jsxs(Shell, { title: "Join workspace", children: [
    /* @__PURE__ */ jsxs("p", { className: "mb-4 text-sm text-[var(--text-secondary)]", children: [
      inviterPrefix,
      " to join ",
      /* @__PURE__ */ jsx2("span", { className: "font-medium text-[var(--text-primary)]", children: workspaceName }),
      roleSuffix,
      "."
    ] }),
    /* @__PURE__ */ jsxs("p", { className: "mb-4 text-sm text-[var(--text-secondary)]", children: [
      "Signed in as ",
      /* @__PURE__ */ jsx2("span", { className: "font-medium text-[var(--text-primary)]", children: details.currentUserEmail })
    ] }),
    expiryLabel && /* @__PURE__ */ jsxs("p", { className: "mb-4 text-xs text-[var(--text-muted)]", children: [
      "This invitation expires on ",
      expiryLabel,
      "."
    ] }),
    emailMismatch && /* @__PURE__ */ jsxs(
      "div",
      {
        role: "alert",
        className: "mb-4 rounded-md border border-[var(--border-default)] px-4 py-2 text-sm text-[var(--text-warning)]",
        children: [
          "This invitation was sent to ",
          /* @__PURE__ */ jsx2("span", { className: "font-medium", children: details.inviteEmail }),
          ". Switch to that account to accept it."
        ]
      }
    ),
    needsVerification && /* @__PURE__ */ jsx2(
      "div",
      {
        role: "alert",
        className: "mb-4 rounded-md border border-[var(--border-default)] px-4 py-2 text-sm text-[var(--text-warning)]",
        children: verificationSent ? "Verification email sent \u2014 check your inbox, then refresh this page to accept." : "Verify your email address before you can accept this invitation."
      }
    ),
    acceptError && /* @__PURE__ */ jsx2("p", { role: "alert", className: "mb-4 text-sm text-[var(--text-danger)]", children: acceptError }),
    /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
      emailMismatch ? /* @__PURE__ */ jsx2(PrimaryButton, { onClick: () => onNavigate({ kind: "switch-account" }), children: "Switch account" }) : needsVerification ? onResendVerification ? /* @__PURE__ */ jsx2(
        PrimaryButton,
        {
          onClick: () => void handleResendVerification(),
          disabled: resendingVerification || verificationSent,
          children: verificationSent ? "Verification sent" : resendingVerification ? "Sending\u2026" : "Resend verification email"
        }
      ) : /* @__PURE__ */ jsx2(PrimaryButton, { onClick: () => onNavigate({ kind: "open-app" }), children: "Open app" }) : /* @__PURE__ */ jsx2(PrimaryButton, { onClick: () => void handleAccept(), disabled: accepting, children: accepting ? "Accepting\u2026" : "Accept invitation" }),
      /* @__PURE__ */ jsx2(SecondaryButton, { onClick: () => onNavigate({ kind: "open-app" }), children: "Not now" })
    ] })
  ] });
}
function Shell({ title, body, children }) {
  return /* @__PURE__ */ jsxs("div", { className: "mx-auto flex w-full max-w-sm flex-col", children: [
    /* @__PURE__ */ jsxs("span", { className: "mb-4 flex items-center gap-2 text-[var(--text-muted)]", children: [
      /* @__PURE__ */ jsx2(BrandMark, { size: 22, className: "shrink-0" }),
      /* @__PURE__ */ jsx2("span", { className: "text-xs font-semibold uppercase tracking-[0.05em]", children: "Tangle Teams" })
    ] }),
    /* @__PURE__ */ jsx2("h1", { className: "mb-1 text-xl font-semibold tracking-tight text-[var(--text-primary)]", children: title }),
    body && /* @__PURE__ */ jsx2("p", { className: "mb-6 text-sm text-[var(--text-secondary)]", children: body }),
    children
  ] });
}
function PrimaryButton({ children, onClick, disabled }) {
  return /* @__PURE__ */ jsx2(
    "button",
    {
      type: "button",
      onClick,
      disabled,
      className: "flex-1 rounded bg-[var(--brand-primary)] px-4 py-2 text-sm text-[hsl(var(--primary-foreground))] disabled:opacity-50",
      children
    }
  );
}
function SecondaryButton({ children, onClick }) {
  return /* @__PURE__ */ jsx2(
    "button",
    {
      type: "button",
      onClick,
      className: "flex-1 rounded border border-[var(--border-default)] px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
      children
    }
  );
}

export {
  InviteAcceptPage
};
//# sourceMappingURL=chunk-W7P5KV6O.js.map