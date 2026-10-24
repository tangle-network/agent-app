import { expectTypeOf, it } from 'vitest'
import type { InteractionPersistedPart, NoticePersistedPart } from '../web-react/chat-interactions'
import type { WorkProductPersistedPart } from '../work-product/types'
import type { ChatPlanPersistedPart } from '../plans/index'
import type { ChatInteractionPart, ChatNoticePart, ChatPlanPart, ChatWorkProductPart } from './parts'

it('keeps codec and stored-part contracts mutually assignable', () => {
  expectTypeOf<InteractionPersistedPart>().toMatchTypeOf<ChatInteractionPart>()
  expectTypeOf<ChatInteractionPart>().toMatchTypeOf<InteractionPersistedPart>()
  expectTypeOf<NoticePersistedPart>().toMatchTypeOf<ChatNoticePart>()
  expectTypeOf<ChatNoticePart>().toMatchTypeOf<NoticePersistedPart>()
  expectTypeOf<ChatPlanPersistedPart>().toMatchTypeOf<ChatPlanPart>()
  expectTypeOf<ChatPlanPart>().toMatchTypeOf<ChatPlanPersistedPart>()
  expectTypeOf<WorkProductPersistedPart>().toMatchTypeOf<ChatWorkProductPart>()
  expectTypeOf<ChatWorkProductPart>().toMatchTypeOf<WorkProductPersistedPart>()
})
