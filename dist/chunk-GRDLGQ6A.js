import {
  RoleSelect
} from "./chunk-AULM4X7U.js";
import {
  hasWorkspaceRole
} from "./chunk-6XIAPIW6.js";

// src/teams-react/components/MembersPanel.tsx
import { useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function MembersPanel({
  members,
  currentRole,
  onInvite,
  onChangeRole,
  onRemove,
  onNotice,
  showInviteForm = true
}) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("editor");
  const [inviting, setInviting] = useState(false);
  const canManage = hasWorkspaceRole(currentRole, "admin");
  function notify(kind, message) {
    onNotice?.({ kind, message });
  }
  async function submitInvite() {
    const email = inviteEmail.trim();
    if (!email || inviting) return;
    setInviting(true);
    try {
      const result = await onInvite({ email, role: inviteRole });
      if (result && "inviteUrl" in result && result.inviteUrl) {
        notify("success", `Invite link ready for ${email}`);
      } else {
        notify("success", `Invited ${email}`);
      }
      setInviteEmail("");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to invite");
    } finally {
      setInviting(false);
    }
  }
  async function changeRole(memberId, role) {
    try {
      await onChangeRole({ memberId, role });
      notify("success", "Role updated");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to update role");
    }
  }
  async function remove(memberId) {
    try {
      await onRemove({ memberId });
      notify("success", "Member removed");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to remove member");
    }
  }
  return /* @__PURE__ */ jsxs("section", { className: "flex flex-col gap-4", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between", children: [
      /* @__PURE__ */ jsx("h4", { className: "text-xs font-semibold text-[var(--text-primary)]", children: "Members" }),
      /* @__PURE__ */ jsxs("span", { className: "text-xs text-[var(--text-muted)]", children: [
        members.length,
        " total"
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2", children: [
      members.map((member) => /* @__PURE__ */ jsx(
        MemberRow,
        {
          member,
          canManage,
          onChangeRole: changeRole,
          onRemove: remove
        },
        member.id
      )),
      members.length === 0 && /* @__PURE__ */ jsx("p", { className: "text-sm text-[var(--text-muted)]", children: "No team members yet." })
    ] }),
    canManage && showInviteForm && /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1.5 border-t border-[var(--border-default)] pt-3", children: [
      /* @__PURE__ */ jsx("label", { className: "text-xs font-medium text-[var(--text-muted)]", children: "Invite member" }),
      /* @__PURE__ */ jsxs("div", { className: "flex gap-2", children: [
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "email",
            placeholder: "Email address",
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
    ] })
  ] });
}
function MemberRow({ member, canManage, onChangeRole, onRemove }) {
  const pending = member.acceptedAt == null;
  const label = member.name ?? member.email ?? "Unknown";
  const initial = (member.name?.[0] ?? member.email?.[0] ?? "?").toUpperCase();
  const isOwner = member.role === "owner";
  const editable = canManage && !isOwner && !member.inherited;
  return /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between border-b border-[var(--border-default)] py-2 last:border-0", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3", children: [
      /* @__PURE__ */ jsx("div", { className: "flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-input)] text-xs font-semibold text-[var(--text-secondary)]", children: initial }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsxs("p", { className: "flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]", children: [
          label,
          pending && /* @__PURE__ */ jsx("span", { className: "rounded border border-[var(--border-default)] px-1.5 py-0.5 text-xs font-semibold uppercase tracking-[0.05em] text-[var(--text-muted)]", children: "Pending" })
        ] }),
        member.name && member.email && /* @__PURE__ */ jsx("p", { className: "text-xs text-[var(--text-muted)]", children: member.email })
      ] })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "flex items-center gap-2", children: isOwner ? /* @__PURE__ */ jsx("span", { className: "rounded border border-[var(--border-default)] px-2 py-0.5 text-xs text-[var(--text-secondary)]", children: member.inherited ? "Org Admin" : "Owner" }) : editable ? /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx(
        RoleSelect,
        {
          value: member.role,
          ariaLabel: `Role for ${label}`,
          onChange: (role) => onChangeRole(member.id, role)
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          "aria-label": `Remove ${label}`,
          onClick: () => onRemove(member.id),
          className: "rounded px-2 py-1 text-xs text-[var(--text-danger)] hover:bg-[var(--border-default)]",
          children: "Remove"
        }
      )
    ] }) : /* @__PURE__ */ jsx("span", { className: "rounded border border-[var(--border-default)] px-2 py-0.5 text-xs capitalize text-[var(--text-secondary)]", children: member.role }) })
  ] });
}

export {
  MembersPanel
};
//# sourceMappingURL=chunk-GRDLGQ6A.js.map