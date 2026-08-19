import { Input } from '@tangle-network/sandbox-ui/primitives'
import { Field, NativeSelect } from './composer-shell'

const VIDEO_DURATIONS = ['4', '6', '8', '10', '12'] as const
const VIDEO_RESOLUTIONS = ['720p', '1080p'] as const
const VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const

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
    <div className="grid grid-cols-2 gap-3">
      <Field label="Duration (s)">
        <NativeSelect value={duration} onChange={(event) => onDurationChange(event.target.value)}>
          {VIDEO_DURATIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Resolution">
        <NativeSelect value={resolution} onChange={(event) => onResolutionChange(event.target.value)}>
          {VIDEO_RESOLUTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Aspect ratio">
        <NativeSelect value={aspectRatio} onChange={(event) => onAspectRatioChange(event.target.value)}>
          {VIDEO_ASPECT_RATIOS.map((option) => <option key={option} value={option}>{option}</option>)}
        </NativeSelect>
      </Field>
      <Field label="Reference image URL"><Input value={referenceImageUrl} onChange={(event) => onReferenceImageUrlChange(event.target.value)} className="bg-background" /></Field>
    </div>
  )
}
