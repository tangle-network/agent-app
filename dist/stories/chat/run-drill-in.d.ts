/**
 * Story-only wiring for the tool row's "Open full transcript" action. In
 * production the host serves a persisted `ToolRunRecord` per `toolCallId`
 * (fail-closed: only ids its own loop created) and mounts `RunDrillIn` itself;
 * the stories have no server, so they synthesize the record from the call's
 * own args/result. That keeps the demo functional — the button opens the real
 * panel over the transcript — instead of dead-ending on a console.log.
 */
import { type ReactNode } from 'react';
import { type ChatToolCallInfo } from '../../web-react';
/**
 * Wrap a ChatMessages story so `onToolCallClick` opens the real `RunDrillIn`
 * panel (and still logs, for parity with the other story hosts). The panel is
 * `fixed` against the canvas's right edge, exactly as `ChatControls/RunDrillIn
 * → Over transcript` mounts it.
 */
export declare function WithRunDrillIn({ children, }: {
    children: (onToolCallClick: (call: ChatToolCallInfo) => void) => ReactNode;
}): import("react").JSX.Element;
