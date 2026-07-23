/**
 * Transcript-side counterpart to the composer's store-backed attachment
 * primitive (agent-app#224). Unlike a `@`-mention, an attachment never rides
 * inline in message text as a token to segment — it renders as its own
 * card/chip keyed off the message's `parts`, so this module is just the
 * browser-safe read side of the attachment vocabulary: the type guard, the
 * per-message part filter, and the two pure conversions a composer/transcript
 * needs before or after a byte upload.
 *
 * `ChatAttachmentPart` and its helpers are re-exported here from
 * `../chat-store/parts` directly (not the `/chat-store` barrel), so a browser
 * bundle gets the attachment vocabulary without importing `/chat-store`, whose
 * barrel pulls the drizzle peer — same reasoning as `./chat-mentions`.
 * `ChatAttachmentKind`/`ChatAttachmentInput` are NOT re-exported from here:
 * they already ship from `./chat-stream` (the import-free `/chat-routes/wire`
 * layer they're defined in), and re-exporting them again from here would
 * collide across the two `export *`s in `./index`.
 */

import {
  attachmentInputToPart,
  attachmentKindForMime,
  attachmentPartKey,
  attachmentPartsFromMessageParts,
  isChatAttachmentPart,
  type ChatAttachmentPart,
} from '../chat-store/parts'

export type { ChatAttachmentPart }
export { attachmentInputToPart, attachmentKindForMime, attachmentPartKey, attachmentPartsFromMessageParts, isChatAttachmentPart }
