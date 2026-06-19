import { Button } from '@tangle-network/sandbox-ui/primitives'
import { Images } from 'lucide-react'

export function StudioHeader({
  count,
  onOpenLibrary,
  canGenerate,
}: {
  count: number
  onOpenLibrary: () => void
  canGenerate: boolean
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">Studio</h1>
          <p className="truncate text-xs text-muted-foreground">
            {canGenerate
              ? 'Generate images, video, voice, avatars, and transcripts.'
              : 'Browse images, video, voice, avatars, and transcripts your team has created.'}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onOpenLibrary} className="shrink-0">
          <Images className="mr-1.5 h-4 w-4" />
          Library
          {count > 0 && (
            <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">
              {count}
            </span>
          )}
        </Button>
      </div>
    </header>
  )
}
