import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { ChatComposer } from '../../web-react'
import type { DictationAudio } from '../../web-react'

/**
 * Dictation wired end to end. The composer owns the capture (mic button,
 * elapsed seconds, blob assembly); the HOST owns what the audio becomes —
 * here it logs the capture and seeds the draft the way a transcription
 * response would.
 *
 * Clicking the mic in a real browser asks for microphone permission. In a
 * headless capture (playwright with `--use-fake-ui-for-media-stream` +
 * `--use-fake-device-for-media-stream`) the fake device records a tone, which
 * is what the demo GIF drives.
 */

const meta: Meta<typeof ChatComposer> = {
  title: 'ChatControls/ChatComposer',
  component: ChatComposer,
  decorators: [
    (Story) => (
      <div className="w-[576px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof ChatComposer>

export const Dictation: Story = {
  render: () => {
    function Demo() {
      const [capture, setCapture] = useState<string | null>(null)
      const [seed, setSeed] = useState<string | null>(null)
      const [error, setError] = useState<string | null>(null)

      const onDictate = (audio: DictationAudio) => {
        const kb = (audio.blob.size / 1024).toFixed(1)
        setError(null)
        setCapture(`${audio.mimeType || 'audio/*'} · ${kb} KB · ${audio.durationSeconds}s`)
        // The host leg: transcribe (sequences-react's Whisper provider) and put
        // the words where the user was going to type them.
        setSeed('Dictated text lands here once the host transcribes the audio.')
      }

      return (
        <div className="space-y-2">
          <ChatComposer
            onSend={(message) => console.log('send', message)}
            placeholder="Message the agent…"
            onDictate={onDictate}
            onDictateError={(message) => {
              setError(message)
              console.log('dictate error', message)
            }}
            seed={seed}
            onSeedApplied={() => setSeed(null)}
          />
          <p className="px-1 text-xs text-muted-foreground" data-testid="dictation-outcome">
            {error
              ? `Capture failed: ${error}`
              : capture
                ? `Last capture: ${capture} — the host transcribes it (sequences-react) and seeds the draft.`
                : 'Click the mic, speak, click stop.'}
          </p>
        </div>
      )
    }
    return <Demo />
  },
}
