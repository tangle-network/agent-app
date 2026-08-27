import { Input } from '@tangle-network/sandbox-ui/primitives'
import { Field, NativeSelect } from './composer-shell'

export function TranscriptionComposer({
  audioUrl,
  language,
  onAudioUrlChange,
  onLanguageChange,
}: {
  audioUrl: string
  language: string
  onAudioUrlChange: (value: string) => void
  onLanguageChange: (value: string) => void
}) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <Field label="Audio URL" htmlFor="studio-audio-url">
        <Input
          id="studio-audio-url"
          value={audioUrl}
          onChange={(event) => onAudioUrlChange(event.target.value)}
          placeholder="https://cdn.example.com/source-audio.mp3"
          className="bg-background"
        />
      </Field>
      <Field label="Language" htmlFor="studio-transcription-language">
        <Input
          id="studio-transcription-language"
          value={language}
          onChange={(event) => onLanguageChange(event.target.value)}
          placeholder="en"
          className="bg-background"
        />
      </Field>
    </div>
  )
}

export function TranscriptionOptions({
  responseFormat,
  temperature,
  onResponseFormatChange,
  onTemperatureChange,
}: {
  responseFormat: string
  temperature: string
  onResponseFormatChange: (value: string) => void
  onTemperatureChange: (value: string) => void
}) {
  return (
    <>
      <Field label="Response format">
        <NativeSelect value={responseFormat} onChange={(event) => onResponseFormatChange(event.target.value)}>
          <option value="json">JSON</option>
          <option value="text">Text</option>
          <option value="srt">SRT</option>
          <option value="verbose_json">Verbose JSON</option>
          <option value="vtt">VTT</option>
        </NativeSelect>
      </Field>
      <Field label="Temperature"><Input type="number" min="0" max="1" step="0.1" value={temperature} onChange={(event) => onTemperatureChange(event.target.value)} className="bg-[var(--md3-surface-container-low)]" /></Field>
    </>
  )
}
