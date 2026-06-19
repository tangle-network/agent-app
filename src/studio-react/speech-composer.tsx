import { Input } from '@tangle-network/sandbox-ui/primitives'
import { Field } from './composer-shell'

export function SpeechComposer({
  voice,
  onVoiceChange,
}: {
  voice: string
  onVoiceChange: (value: string) => void
}) {
  return (
    <Field label="Voice"><Input value={voice} onChange={(event) => onVoiceChange(event.target.value)} /></Field>
  )
}
