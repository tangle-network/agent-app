import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { TranscriptionComposer, TranscriptionOptions } from '../../studio-react'

const meta: Meta<typeof TranscriptionComposer> = {
  title: 'Studio/TranscriptionComposer',
  component: TranscriptionComposer,
  decorators: [
    (Story) => (
      <div className="w-[560px] p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    audioUrl: '',
    language: '',
    onAudioUrlChange: (value) => console.log('onAudioUrlChange', value),
    onLanguageChange: (value) => console.log('onLanguageChange', value),
  },
}

export default meta
type Story = StoryObj<typeof TranscriptionComposer>

export const Default: Story = {}

export const Populated: Story = {
  args: {
    audioUrl: 'https://cdn.example.com/dailies-day-12.mp3',
    language: 'en',
  },
}

export const Interactive: Story = {
  render: function TranscriptionComposerDemo() {
    const [audioUrl, setAudioUrl] = useState('')
    const [language, setLanguage] = useState('')
    return (
      <TranscriptionComposer
        audioUrl={audioUrl}
        language={language}
        onAudioUrlChange={setAudioUrl}
        onLanguageChange={setLanguage}
      />
    )
  },
}

/** The advanced-options row the hero mounts inside its disclosure. */
export const Options: Story = {
  render: function TranscriptionOptionsDemo() {
    const [responseFormat, setResponseFormat] = useState('srt')
    const [temperature, setTemperature] = useState('0.2')
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <TranscriptionOptions
          responseFormat={responseFormat}
          temperature={temperature}
          onResponseFormatChange={setResponseFormat}
          onTemperatureChange={setTemperature}
        />
      </div>
    )
  },
}
