import { Input } from '@tangle-network/sandbox-ui/primitives'
import { MIN_IMAGE_COUNT, MAX_IMAGE_COUNT, normalizeImageCount } from '../studio'
import { Field, NativeSelect, Stepper } from './composer-shell'

const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const
const IMAGE_SIZE_HINT = '1024x1024, 1536x1024, 1024x1536, or auto'
const IMAGE_SIZE_PATTERN = String.raw`(\d{3,4}x\d{3,4}|auto)`

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
        <Field label="Size">
          <Input
            value={size}
            onChange={(event) => onSizeChange(event.target.value)}
            pattern={IMAGE_SIZE_PATTERN}
            placeholder={IMAGE_SIZE_HINT}
            className="bg-background"
          />
        </Field>
        <Field label="Quality">
          <NativeSelect value={quality} onChange={(event) => onQualityChange(event.target.value)}>
            {IMAGE_QUALITIES.map((option) => (
              <option key={option} value={option}>{option.charAt(0).toUpperCase() + option.slice(1)}</option>
            ))}
          </NativeSelect>
        </Field>
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
