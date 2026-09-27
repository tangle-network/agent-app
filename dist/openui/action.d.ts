/**
 * What travels when a user presses a button on a page the agent authored.
 *
 * The submission is a plain REST body, not a chat turn. That is the entire
 * point of this module: pressing "Recalculate" on an agent-authored form must
 * cost the same as pressing a button on a hand-built screen — one product route
 * call, no model tokens, no sandbox wake-up. The wire shape here is therefore
 * deliberately small and self-contained: an action id, the form it belongs to,
 * that form's current values, and enough addressing for the product to find the
 * page. Nothing in it references a session, a turn, or a run.
 */
import { type OpenUIFormValues } from './values';
/** What the browser POSTs when an action fires. */
export interface OpenUIActionSubmission {
    /** The action's stable id, as authored on the page. */
    actionId: string;
    /** The form whose values are attached, when the action sits in one. */
    formId?: string;
    /** Current values of that form, keyed by field id. Empty for a bare action. */
    values: OpenUIFormValues;
    /** The node the action was rendered on, when the page carries several. */
    nodeId?: string;
    /** Vault path of the persisted `render_ui` artifact this page came from. */
    artifactPath?: string;
}
/** Parsed submission, or the reason the body was refused. */
export type OpenUIActionBodyValidation = {
    ok: true;
    submission: OpenUIActionSubmission;
} | {
    ok: false;
    code: OpenUIActionBodyErrorCode;
    error: string;
};
/** Why a submission body was refused before any handler ran. */
export type OpenUIActionBodyErrorCode = 'OPENUI_ACTION_ID_MISSING' | 'OPENUI_ACTION_ID_INVALID' | 'OPENUI_FORM_ID_INVALID' | 'OPENUI_NODE_ID_INVALID' | 'OPENUI_ARTIFACT_PATH_INVALID' | 'OPENUI_VALUES_INVALID' | 'OPENUI_FIELD_ID_INVALID' | 'OPENUI_FIELD_VALUE_INVALID';
/** Ids the host accepts on the wire: identifier-safe, same rule as field ids. */
export declare function isSafeOpenUIActionId(id: string): boolean;
/**
 * Validate a raw JSON body into a submission. Every rejection names a code so
 * the browser can tell "the page sent something malformed" from "the product
 * refused the action".
 */
export declare function validateOpenUIActionBody(body: Record<string, unknown>): OpenUIActionBodyValidation;
/**
 * One plain line recording what the user did, for the product to carry into the
 * NEXT turn's context.
 *
 * The action itself spends no model tokens; without a record of it the agent
 * would later reason about a page the user has already changed. Appending this
 * to the thread (as a note, a system line, or a stored part) is how the agent
 * catches up on the next turn the user actually pays for.
 */
export declare function describeOpenUIAction(submission: OpenUIActionSubmission): string;
