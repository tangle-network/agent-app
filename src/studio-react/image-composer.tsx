import { Input } from '@tangle-network/sandbox-ui/primitives'
import { MIN_IMAGE_COUNT, MAX_IMAGE_COUNT, normalizeImageCount } from '../studio'
import { Field } from './composer-shell'

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
    <>
      <Field label="Size"><Input value={size} onChange={(event) => onSizeChange(event.target.value)} /></Field>
      <Field label="Quality"><Input value={quality} onChange={(event) => onQualityChange(event.target.value)} /></Field>
      <Field label="Images"><Input type="number" min={MIN_IMAGE_COUNT} max={MAX_IMAGE_COUNT} value={imageCount} onChange={(event) => onImageCountChange(normalizeImageCount(event.target.value))} /></Field>
    </>
  )
}
