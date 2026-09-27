import {
  RoleSelect
} from "./chunk-AULM4X7U.js";
import {
  hasWorkspaceRole
} from "./chunk-6XIAPIW6.js";

// src/teams-react/components/InvitationsPanel.tsx
import { useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var BADGE_BASE = "inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.05em]";
var STATUS_BADGE = {
  accepted: "border-[var(--surface-success-border)] bg-[var(--surface-success-bg)] text-[var(--surface-success-text)]",
  pending: "border-[var(--surface-warning-border)] bg-[var(--surface-warning-bg)] text-[var(--surface-warning-text)]",
  revoked: "border-[var(--surface-danger-border)] bg-[var(--surface-danger-bg)] text-[var(--surface-danger-text)]",
  expired: "border-[var(--border-default)] text-[var(--text-muted)]"
};
var EMAIL_BADGE = {
  sent: "border-[var(--border-default)] text-[var(--text-muted)]",
  not_sent: "border-[var(--surface-warning-border)] bg-[var(--surface-warning-bg)] text-[var(--surface-warning-text)]",
  failed: "border-[var(--surface-danger-border)] bg-[var(--surface-danger-bg)] text-[var(--surface-danger-text)]"
};
function capitalize(text) {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}
function InvitationsPanel({
  invitations,
  currentRole,
  onInvite,
  onResend,
  onRevoke,
  onCopy,
  onNotice
}) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("editor");
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const canManage = hasWorkspaceRole(currentRole, "admin");
  function notify(kind, message) {
    onNotice?.({ kind, message });
  }
  async function submitInvite() {
    const email = inviteEmail.trim();
    if (!email || inviting) return;
    setInviting(true);
    try {
      await onInvite({ email, role: inviteRole });
      notify("success", `Invitation sent to ${email}`);
      setInviteEmail("");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to invite");
    } finally {
      setInviting(false);
    }
  }
  async function copyLink(inviteUrl) {
    try {
      if (onCopy) await onCopy({ inviteUrl });
      else await navigator.clipboard.writeText(inviteUrl);
      notify("success", "Invite link copied");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to copy link");
    }
  }
  async function resend(invitationId) {
    setBusyId(invitationId);
    try {
      await onResend({ invitationId });
      notify("success", "Invitation resent");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to resend invitation");
    } finally {
      setBusyId(null);
    }
  }
  async function revoke(invitationId) {
    setBusyId(invitationId);
    try {
      await onRevoke({ invitationId });
      notify("success", "Invitation revoked");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to revoke invitation");
    } finally {
      setBusyId(null);
    }
  }
  return /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-4", children: [
    canManage && /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1.5", children: [
      /* @__PURE__ */ jsx("label", { className: "text-xs font-medium text-[var(--text-muted)]", children: "Invite by email" }),
      /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "email",
            placeholder: "colleague@example.com",
            value: inviteEmail,
            "aria-label": "Invite email address",
            onChange: (event) => setInviteEmail(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter") void submitInvite();
            },
            className: "flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          }
        ),
        /* @__PURE__ */ jsx(
          RoleSelect,
          {
            value: inviteRole,
            ariaLabel: "Invite role",
            onChange: setInviteRole
          }
        ),
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            onClick: () => void submitInvite(),
            disabled: inviting || !inviteEmail.trim(),
            className: "rounded bg-[var(--brand-primary)] px-3 py-1.5 text-sm text-[hsl(var(--primary-foreground))] disabled:opacity-50",
            children: inviting ? "Inviting\u2026" : "Invite"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2 border-t border-[var(--border-default)] pt-3", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between", children: [
        /* @__PURE__ */ jsx("h4", { className: "text-xs font-semibold text-[var(--text-primary)]", children: "Invitation history" }),
        /* @__PURE__ */ jsxs("span", { className: "text-xs text-[var(--text-muted)]", children: [
          invitations.length,
          " total"
        ] })
      ] }),
      invitations.length === 0 ? /* @__PURE__ */ jsx("p", { className: "text-sm text-[var(--text-muted)]", children: "No invitations yet." }) : invitations.map((invitation) => /* @__PURE__ */ jsx(
        InvitationRow,
        {
          invitation,
          canManage,
          busy: busyId === invitation.id,
          onCopy: () => void copyLink(invitation.inviteUrl),
          onResend: () => void resend(invitation.id),
          onRevoke: () => void revoke(invitation.id)
        },
        invitation.id
      ))
    ] })
  ] });
}
function InvitationRow({ invitation, canManage, busy, onCopy, onResend, onRevoke }) {
  const isPending = invitation.status === "pending";
  const emailFailed = invitation.emailStatus === "failed";
  const expiry = new Date(invitation.expiresAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  return /* @__PURE__ */ jsxs("div", { className: "rounded-lg border border-[var(--border-default)] bg-[var(--bg-input)] p-3", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-start justify-between gap-3", children: [
      /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
        /* @__PURE__ */ jsx("p", { className: "truncate text-sm font-medium text-[var(--text-primary)]", children: invitation.email }),
        /* @__PURE__ */ jsxs("p", { className: "text-xs text-[var(--text-muted)]", children: [
          capitalize(invitation.permissions),
          " \xB7 expires ",
          expiry
        ] }),
        emailFailed && /* @__PURE__ */ jsx("p", { className: "mt-1 text-xs text-[var(--surface-danger-text)]", children: "Email was not sent \u2014 copy the link to share it." })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "flex shrink-0 items-center gap-2", children: [
        /* @__PURE__ */ jsx("span", { className: `${BADGE_BASE} ${STATUS_BADGE[invitation.status]}`, children: invitation.status }),
        /* @__PURE__ */ jsx("span", { className: `${BADGE_BASE} ${EMAIL_BADGE[invitation.emailStatus]}`, children: invitation.emailStatus.replace("_", " ") })
      ] })
    ] }),
    canManage && isPending && /* @__PURE__ */ jsxs("div", { className: "mt-3 flex items-center justify-end gap-2", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: onCopy,
          disabled: busy,
          className: "rounded border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50",
          children: "Copy link"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: onResend,
          disabled: busy,
          className: "rounded border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50",
          children: busy ? "Working\u2026" : "Resend"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: onRevoke,
          disabled: busy,
          className: "rounded px-2 py-1 text-xs text-[var(--text-danger)] hover:bg-[var(--border-default)] disabled:opacity-50",
          children: "Revoke"
        }
      )
    ] })
  ] });
}

export {
  InvitationsPanel
};
//# sourceMappingURL=chunk-5MI2SKQH.js.map