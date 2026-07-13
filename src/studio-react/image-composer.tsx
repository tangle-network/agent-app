import { Input } from '@tangle-network/sandbox-ui/primitives'
import { MIN_IMAGE_COUNT, MAX_IMAGE_COUNT, normalizeImageCount } from '../studio'
import { Field, Stepper } from './composer-shell'

export function ImageComposer({
  size,
  quality,
  imageCount,
  onSizeChange,
  onQualityChange,
  onImageCountChange,
}: {
  size: string
  quality: string
  imageCount: number
  onSizeChange: (value: string) => void
  onQualityChange: (value: string) => void
  onImageCountChange: (value: number) => void
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Size"><Input value={size} onChange={(event) => onSizeChange(event.target.value)} className="bg-background" /></Field>
        <Field label="Quality"><Input value={quality} onChange={(event) => onQualityChange(event.target.value)} className="bg-background" /></Field>
      </div>
      <Field label="Images">
        <Stepper
          value={imageCount}
          min={MIN_IMAGE_COUNT}
          max={MAX_IMAGE_COUNT}
          onChange={(value) => onImageCountChange(normalizeImageCount(value))}
        />
      </Field>
    </div>
  )
}
