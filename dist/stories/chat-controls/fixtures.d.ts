/**
 * Chat-controls story fixtures — area-local because the shared
 * `src/stories/fixtures/` barrel is absent from this checkout (the storybook
 * scaffolding was never committed; see the chat-controls handoff note). The
 * catalog list mirrors the documented shared `catalogModels` fixture
 * 1:1 so a later dedupe pass is a pure import swap.
 *
 * Everything here is typed against package source (`../../web-react` and the
 * leaf modules the components themselves import from), so a drift in any of
 * these shapes fails typecheck in this file.
 */
import { type ReactNode } from 'react';
import type { Decorator } from '@storybook/react';
import type { AgentActivityPage, CatalogModel, ChatAttachmentPart, ChatEmptyDoor, ChatInteraction, ComposerFile, SubmitInteractionAnswer, ToolRunRecord, WorkProductCardProps } from '../../web-react';
import type { StepAgentActivity } from '../../missions/agent-activity';
import type { FlowTrace } from '../../trace';
import type { ChatPlan } from '../../plans';
import type { WorkProductPersistedPart } from '../../work-product/types';
import type { ProductSeatOffer } from '../../platform/billing';
/** Current five-model catalogue used across the chat-control stories. */
export declare const catalogModels: CatalogModel[];
export declare const DEFAULT_MODEL_ID: string;
/** A model with `supportsReasoning: false` — the effort picker hides for it. */
export declare const NON_REASONING_MODEL_ID = "deepseek/deepseek-chat";
/** The exact pending-file pair the playground's ComposerRoute ships. */
export declare const pendingComposerFiles: ComposerFile[];
/** Adds an errored chip so the destructive tone and its reason are covered. */
export declare const pendingComposerFilesWithError: ComposerFile[];
/** A staged image whose thumbnail identifies it — the shape a pasted
 *  screenshot arrives in, where the auto-generated name says nothing. A data
 *  URL keeps the story free of an object URL nobody would revoke. */
export declare const pendingComposerImageFiles: ComposerFile[];
export declare const fileAttachmentParts: ChatAttachmentPart[];
export declare const imageAttachmentParts: ChatAttachmentPart[];
export declare const mixedAttachmentParts: ChatAttachmentPart[];
/** Serves real bytes for every attachment URL — thumbnails render. */
export declare const fetchAttachmentOk: (url: string) => Promise<Response>;
/** 404s every URL — thumbnails flip to the error tile, chips error on click. */
export declare const fetchAttachmentMissing: () => Promise<Response>;
/** Never settles — thumbnails hold the loading skeleton. */
export declare const fetchAttachmentHangs: () => Promise<Response>;
export declare const resolveAttachmentUrl: (part: ChatAttachmentPart) => string;
export declare const emptyStateDoors: ChatEmptyDoor[];
export declare const completedToolRun: ToolRunRecord;
export declare const erroredToolRun: ToolRunRecord;
export declare const runningToolRun: ToolRunRecord;
/** One part per `WorkProductStatus` — every pill tone the card can render. */
export declare const workProductParts: WorkProductPersistedPart[];
export declare const openWorkProduct: WorkProductCardProps['onOpen'];
/** The plan-approval ask, waiting on the human. */
export declare const pendingPlanInteraction: ChatInteraction;
/** Long enough (>320px) that the body collapses behind "Show full plan". */
export declare const longPlanInteraction: ChatInteraction;
export declare const approvedPlanInteraction: ChatInteraction;
export declare const declinedPlanInteraction: ChatInteraction;
export declare const expiredPlanInteraction: ChatInteraction;
/** Single-select ask with per-option descriptions. */
export declare const selectQuestionInteraction: ChatInteraction;
/** Multi-select with a granted write-in row (`allowCustom`). */
export declare const channelsQuestionInteraction: ChatInteraction;
/** Free-text ask with a length cap. */
export declare const freeTextQuestionInteraction: ChatInteraction;
/** One of each open input kind: boolean, number, secret. */
export declare const credentialsQuestionInteraction: ChatInteraction;
export declare const answeredQuestionInteraction: ChatInteraction;
export declare const expiredQuestionInteraction: ChatInteraction;
export declare const okSubmitAnswer: SubmitInteractionAnswer;
export declare const logResolved: (id: string, status: string, answers?: unknown) => void;
export declare const okLateAnswer: (message: string) => boolean;
export declare const okReRequest: (interaction: ChatInteraction) => boolean;
export declare const pendingDurablePlan: ChatPlan;
export declare const approvedDurablePlan: ChatPlan;
export declare const rejectedDurablePlan: ChatPlan;
export declare const withdrawnDurablePlan: ChatPlan;
/** Seat offer with a discounted first month — the `offer` prop's render path. */
export declare const seatOffer: ProductSeatOffer;
export declare const activityLaneRuns: StepAgentActivity[];
/** Cursor-paged data port: first page carries `nextCursor`, the second ends. */
export declare const fetchActivityPopulated: (cursor?: string) => Promise<AgentActivityPage>;
export declare const fetchActivityEmpty: () => Promise<AgentActivityPage>;
export declare const fetchActivityError: () => Promise<AgentActivityPage>;
/** Never settles — the refresh spinner holds. */
export declare const fetchActivityHangs: () => Promise<AgentActivityPage>;
export declare const posterFlowTrace: FlowTrace;
export declare const failedFlowTrace: FlowTrace;
/**
 * Clicks the first button inside its subtree on mount — the trick that renders
 * a popover-driven control (ModelPicker, EffortPicker, the lane's "timeline"
 * toggle) in its OPEN state for a static story. Programmatic `click()` fires
 * no `mousedown`, so `usePopover`'s outside-click closer does not immediately
 * re-close it.
 */
export declare function AutoClick({ children, selector }: {
    children: ReactNode;
    selector?: string;
}): import("react").JSX.Element;
/**
 * Real positive-Y headroom for upward-opening popovers. ModelPicker,
 * EffortPicker, and AgentSessionControls' menus are inline-absolute
 * `bottom-full` popovers: opened near the canvas top they extend into
 * negative-Y space, which the iframe cannot scroll to — the popover reads as
 * clipped no matter the layout. (The old `pt-[NNNpx]` wrappers only pushed
 * the trigger down a fixed amount; the popover still overflowed whenever the
 * canvas was shorter than the pad plus the popover.)
 *
 * This decorator anchors the story to the BOTTOM of a 520px-tall block
 * (`flex items-end`), so the popover opens into canvas space above the
 * trigger. 520px covers the tallest popover (ModelPicker ~470px; the gear
 * menu ~260px and EffortPicker ~210px fit with room to spare). Works under
 * both `centered` and `padded` layouts.
 *
 *   decorators: [withPopoverHeadroom]
 */
export declare const withPopoverHeadroom: Decorator;
/**
 * Minimal line-based markdown renderer for the plan/question cards'
 * `renderMarkdown` slot — just enough structure (headings, lists, quotes) for
 * the card stories to show formatted copy instead of the pre-wrap fallback.
 */
export declare function renderStoryMarkdown(markdown: string): ReactNode;
