// src/teams-react/lazy.tsx
import { lazy } from "react";
var MembersPanelLazy = lazy(
  () => import("../MembersPanel-3ZK2GCMC.js").then((m) => ({ default: m.MembersPanel }))
);
var InvitationsPanelLazy = lazy(
  () => import("../InvitationsPanel-OFCYVSAE.js").then((m) => ({ default: m.InvitationsPanel }))
);
var InviteAcceptPageLazy = lazy(
  () => import("../InviteAcceptPage-BDOO4JSE.js").then((m) => ({ default: m.InviteAcceptPage }))
);
export {
  InvitationsPanelLazy,
  InviteAcceptPageLazy,
  MembersPanelLazy
};
//# sourceMappingURL=lazy.js.map