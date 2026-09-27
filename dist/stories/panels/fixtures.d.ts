/**
 * Fixtures for the panels area (teams / intakes / work-product). Local to this
 * area: the shared `src/stories/fixtures` barrel covers chat, catalog, canvas,
 * and sequences — none of which these surfaces consume.
 *
 * Shapes mirror the API seams: `MemberView` / `InvitationView` are what
 * `teams/members-api` and `teams/invitations-api` return, `IntakeView` is what
 * `intakes/api` returns, and `WorkProductRecord` is the durable review row.
 */
import type { IntakeAnswers } from '../../intakes/model';
import type { IntakeView } from '../../intakes-react';
import type { InviteAcceptDetails, InvitationView, MemberView } from '../../teams-react';
import type { ProfileBacktestSummary, WorkProductRecord } from '../../work-product/types';
/** A realistic workspace roster: an explicit owner, an inherited org owner
 *  (not editable here), one of each assignable role, and a pending invite. */
export declare const MEMBERS: MemberView[];
/** Every lifecycle status × every email-delivery status a history list shows. */
export declare const INVITATIONS: InvitationView[];
/** The valid, signed-out invite — the landing state of `/invite/:token`. */
export declare const INVITE_SIGNED_OUT: InviteAcceptDetails;
/** Signed in as the invited address — the accept action is live. */
export declare const INVITE_READY: InviteAcceptDetails;
/** Signed in as someone else — the switch-account branch. */
export declare const INVITE_EMAIL_MISMATCH: InviteAcceptDetails;
/** Right address, unverified — the resend-verification branch. */
export declare const INVITE_NEEDS_VERIFICATION: InviteAcceptDetails;
/** Derive a view from the graph the same way `intakes/api` does — the server
 *  re-derives next question + progress after every persisted answer. */
export declare function intakeViewFor(answers: IntakeAnswers, completed?: boolean): IntakeView;
/** Answer snapshots at each step of the flow, for the static step stories. */
export declare const INTAKE_STEPS: {
    /** Nothing answered — the text question, progress 0/3. */
    start: {};
    /** Name answered — the single-select question, progress 1/3. */
    role: {
        name: string;
    };
    /** Role answered — the boolean question (optional multi-select skipped), 2/3. */
    briefings: {
        name: string;
        role: string;
    };
    /** All required answered — nextQuestion is null, the Finish action shows. */
    ready: {
        name: string;
        role: string;
        stack: string[];
        briefings: true;
    };
};
/** Bodies behind `history[].artifactPath`, for the version-compare seam. */
export declare const VERSION_BODIES: Record<string, string>;
/** A ready-for-review legal redline: baseline diff, span/model evidence,
 *  one exception per severity, mixed-verdict checks, and a 3-version history. */
export declare const REDLINE_RECORD: WorkProductRecord;
/** The trust-gate-passing backtest summary for the redline record's profile. */
export declare const BACKTEST_PASS: ProfileBacktestSummary;
/** An accumulating draft: artifact null, every list empty — the "nothing to
 *  review yet" pane (artifact tab renders its empty copy). */
export declare const DRAFT_RECORD: WorkProductRecord;
/** A tax-style fields package: no markdown body — the artifact is a structured
 *  field map (rendered as JSON) and lineage anchors to form-line ids. */
export declare const FIELDS_RECORD: WorkProductRecord;
