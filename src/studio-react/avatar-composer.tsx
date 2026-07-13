import { Input } from '@tangle-network/sandbox-ui/primitives'
import { Field } from './composer-shell'

export function AvatarComposer({
  audioUrl,
  imageUrl,
  avatarId,
  onAudioUrlChange,
  onImageUrlChange,
  onAvatarIdChange,
}: {
  audioUrl: string
  imageUrl: string
  avatarId: string
  onAudioUrlChange: (value: string) => void
  onImageUrlChange: (value: string) => void
  onAvatarIdChange: (value: string) => void
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
      <Field label="Image URL" htmlFor="studio-avatar-image-url">
        <Input
          id="studio-avatar-image-url"
          value={imageUrl}
          onChange={(event) => onImageUrlChange(event.target.value)}
          placeholder="https://cdn.example.com/portrait.png"
          className="bg-background"
        />
      </Field>
      <Field label="Avatar ID" htmlFor="studio-avatar-id">
        <Input
          id="studio-avatar-id"
          value={avatarId}
          onChange={(event) => onAvatarIdChange(event.target.value)}
          placeholder="Optional provider avatar id"
          className="bg-background"
        />
      </Field>
    </div>
  )
}
