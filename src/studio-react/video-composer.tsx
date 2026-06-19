import { Input } from '@tangle-network/sandbox-ui/primitives'
import { Field } from './composer-shell'

export function VideoComposer({
  duration,
  resolution,
  aspectRatio,
  referenceImageUrl,
  onDurationChange,
  onResolutionChange,
  onAspectRatioChange,
  onReferenceImageUrlChange,
}: {
  duration: string
  resolution: string
  aspectRatio: string
  referenceImageUrl: string
  onDurationChange: (value: string) => void
  onResolutionChange: (value: string) => void
  onAspectRatioChange: (value: string) => void
  onReferenceImageUrlChange: (value: string) => void
}) {
  return (
    <>
      <Field label="Duration (s)"><Input value={duration} onChange={(event) => onDurationChange(event.target.value)} /></Field>
      <Field label="Resolution"><Input value={resolution} onChange={(event) => onResolutionChange(event.target.value)} /></Field>
      <Field label="Aspect ratio"><Input value={aspectRatio} onChange={(event) => onAspectRatioChange(event.target.value)} /></Field>
      <Field label="Reference image URL"><Input value={referenceImageUrl} onChange={(event) => onReferenceImageUrlChange(event.target.value)} /></Field>
    </>
  )
}
