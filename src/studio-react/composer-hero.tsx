import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge, Button, Input, Label, Textarea,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@tangle-network/sandbox-ui/primitives'
import { useIntegrations } from '@tangle-network/sandbox-ui/integrations'
import { Sparkles } from 'lucide-react'
import {
  type Generation,
  type GenerationType,
  type MediaModelCatalogResponse,
  CADENCES,
  DESTINATIONS,
  buildGenerationRequestBody,
  buildPublishPackage,
  failedOptimisticGeneration,
  isDestinationConnected,
  modelMessage,
  normalizeImageCount,
  optimisticGeneration,
  outputPathFor,
  preferredModelId,
  selectedModelsWithDefaults,
  userSafeGenerationMessage,
} from '../studio'
import { TYPE_CONFIG, typeConfigFor } from './type-config'
import { ComposerDisclosure, Field } from './composer-shell'
import { ImageComposer } from './image-composer'
import { VideoComposer } from './video-composer'
import { SpeechComposer } from './speech-composer'
import { AvatarComposer } from './avatar-composer'
import { TranscriptionComposer, TranscriptionOptions } from './transcription-composer'
import { PublishPackageComposer } from './publish-package-composer'

const HUB_BASE_URL = '/api/integrations/hub'

const SUGGESTIONS: Array<{ label: string; prompt: string; type: GenerationType }> = [
  {
    label: 'Storyboard frame',
    type: 'image',
    prompt: 'A vertical storyboard frame for a product launch teaser — dark cinematic lighting, sleek studio aesthetic, 9:16 composition.',
  },
  {
    label: 'Launch teaser clip',
    type: 'video',
    prompt: 'A 6-second vertical launch teaser: animated product reveal, dynamic camera move, hero music swell.',
  },
  {
    label: 'Scratch voiceover',
    type: 'speech',
    prompt: 'A confident 12-second scratch voiceover for a product launch teaser: warm tone, conversational pace.',
  },
  {
    label: 'Transcribe dailies',
    type: 'transcription',
    prompt: 'Transcribe the latest dailies recording with timestamps, speaker labels, and key story beats highlighted.',
  },
]

export function ComposerHero({
  workspaceId,
  integrationsHref,
  canManageIntegrations,
  onGenerated,
}: {
  workspaceId?: string
  integrationsHref?: string
  canManageIntegrations: boolean
  onGenerated: (generation: Generation) => void
}) {
  const [type, setType] = useState<GenerationType>('image')
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [outputPath, setOutputPath] = useState(outputPathFor('image'))
  const [caption, setCaption] = useState('')
  const [postDescription, setPostDescription] = useState('')
  const [mentions, setMentions] = useState('')
  const [cadence, setCadence] = useState(CADENCES[0] ?? 'Manual approval')
  const [selectedDestinations, setSelectedDestinations] = useState<string[]>([])
  const [size, setSize] = useState('1536x1024')
  const [quality, setQuality] = useState('high')
  const [imageCount, setImageCount] = useState(1)
  const [duration, setDuration] = useState('6')
  const [resolution, setResolution] = useState('720p')
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [referenceImageUrl, setReferenceImageUrl] = useState('')
  const [voice, setVoice] = useState('alloy')
  const [avatarAudioUrl, setAvatarAudioUrl] = useState('')
  const [avatarImageUrl, setAvatarImageUrl] = useState('')
  const [avatarId, setAvatarId] = useState('')
  const [transcriptionAudioUrl, setTranscriptionAudioUrl] = useState('')
  const [transcriptionLanguage, setTranscriptionLanguage] = useState('')
  const [transcriptionResponseFormat, setTranscriptionResponseFormat] = useState('json')
  const [transcriptionTemperature, setTranscriptionTemperature] = useState('0')
  const [mediaModels, setMediaModels] = useState<MediaModelCatalogResponse | null>(null)
  const [mediaModelsLoading, setMediaModelsLoading] = useState(false)
  const [mediaModelsError, setMediaModelsError] = useState<string | null>(null)
  const [selectedModels, setSelectedModels] = useState<Partial<Record<GenerationType, string>>>({})
  const submitLockRef = useRef(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modelsForType = mediaModels?.models[type] ?? []
  const selectedModel = selectedModels[type] ?? preferredModelId(type, mediaModels) ?? ''
  const selectedModelOption = modelsForType.find((model) => model.id === selectedModel)
  const modelReady = Boolean(selectedModelOption)
    && selectedModelOption?.status !== 'unavailable'
    && !mediaModelsLoading
    && !mediaModelsError
  const hasRequiredInput = type === 'transcription'
    ? Boolean(transcriptionAudioUrl.trim())
    : type === 'avatar'
      ? Boolean(avatarAudioUrl.trim())
      : Boolean(prompt.trim())
  const canSubmit = Boolean(workspaceId)
    && modelReady
    && hasRequiredInput
    && !isSubmitting
  const integrations = useIntegrations({ apiBaseUrl: HUB_BASE_URL })
  const selectedConnectedDestinations = useMemo(() => selectedDestinations.filter((destinationId) => {
    const destination = DESTINATIONS.find((item) => item.id === destinationId)
    return Boolean(destination && isDestinationConnected(destination, integrations.connections))
  }), [integrations.connections, selectedDestinations])

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    setMediaModelsLoading(true)
    setMediaModelsError(null)

    fetch(`/api/media-models?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(async (res) => {
        const data = await res.json() as MediaModelCatalogResponse
        if (!res.ok) throw new Error(data.error ?? 'Could not load media models')
        return data
      })
      .then((data) => {
        if (cancelled) return
        setMediaModels(data)
        setSelectedModels((current) => selectedModelsWithDefaults(current, data))
      })
      .catch((err) => {
        if (cancelled) return
        setMediaModels(null)
        setMediaModelsError(err instanceof Error ? err.message : 'Could not load media models')
      })
      .finally(() => {
        if (!cancelled) setMediaModelsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  function changeType(next: GenerationType) {
    setType(next)
    setOutputPath(outputPathFor(next))
  }

  async function generate() {
    if (!workspaceId || submitLockRef.current) return
    const promptText = prompt.trim()
    const avatarAudioUrlText = avatarAudioUrl.trim()
    const transcriptionAudioUrlText = transcriptionAudioUrl.trim()
    if (type !== 'transcription' && type !== 'avatar' && !promptText) {
      setError('prompt is required')
      return
    }
    if (type === 'avatar' && !avatarAudioUrlText) {
      setError('audioUrl is required')
      return
    }
    if (type === 'transcription' && !transcriptionAudioUrlText) {
      setError('audioUrl is required')
      return
    }
    if (!selectedModelOption || selectedModelOption.status === 'unavailable') {
      setError(`Select an available ${typeConfigFor(type).label} model`)
      return
    }
    if (cadence === 'Publish now' && selectedConnectedDestinations.length === 0) {
      setError('Select a connected destination to publish now')
      return
    }
    submitLockRef.current = true
    setIsSubmitting(true)
    setError(null)
    const clientRequestId = crypto.randomUUID()
    const requestedImageCount = type === 'image' ? normalizeImageCount(imageCount) : 1
    if (type === 'image' && requestedImageCount !== imageCount) setImageCount(requestedImageCount)
    const localGenerations = Array.from({ length: requestedImageCount }, (_, outputIndex) => optimisticGeneration({
      type,
      prompt: promptText || transcriptionAudioUrlText || avatarAudioUrlText,
      model: selectedModel,
      clientRequestId,
      outputIndex: type === 'image' ? outputIndex : undefined,
      outputCount: type === 'image' ? requestedImageCount : undefined,
    }))
    localGenerations.slice().reverse().forEach(onGenerated)
    setPrompt('')
    let receivedServerGeneration = false
    try {
      const body = buildGenerationRequestBody({
        workspaceId,
        clientRequestId,
        type,
        model: selectedModel,
        prompt,
        negativePrompt,
        outputPath,
        publishPackage: buildPublishPackage({
          caption,
          postDescription,
          mentions,
          cadence,
          destinations: selectedConnectedDestinations,
        }),
        image: { size, quality, count: requestedImageCount },
        video: { duration, resolution, aspectRatio, referenceImageUrl },
        speech: { voice },
        avatar: { audioUrl: avatarAudioUrl, imageUrl: avatarImageUrl, avatarId },
        transcription: {
          audioUrl: transcriptionAudioUrl,
          language: transcriptionLanguage,
          responseFormat: transcriptionResponseFormat,
          temperature: transcriptionTemperature,
        },
      })

      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json() as { generation?: Generation; generations?: Generation[]; error?: string }
      const serverGenerations = data.generations?.length ? data.generations : data.generation ? [data.generation] : []
      if (serverGenerations.length > 0) {
        receivedServerGeneration = true
        serverGenerations.slice().reverse().forEach(onGenerated)
      }
      if (!res.ok || serverGenerations.length === 0) throw new Error(userSafeGenerationMessage(data.error))
    } catch (err) {
      if (!receivedServerGeneration) localGenerations.map(failedOptimisticGeneration).forEach(onGenerated)
      setError(err instanceof Error ? userSafeGenerationMessage(err.message) : 'Generation failed')
    } finally {
      submitLockRef.current = false
      setIsSubmitting(false)
    }
  }

  const mediaTypes = Object.entries(TYPE_CONFIG) as Array<[GenerationType, typeof TYPE_CONFIG[string]]>
  const hasInlineParams = type === 'image' || type === 'video' || type === 'speech'

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <Field label="Media type" className="space-y-1.5">
        <div
          role="tablist"
          aria-label="Generation type"
          className="grid grid-cols-5 gap-1 rounded-lg border border-border bg-muted/40 p-1"
        >
          {mediaTypes.map(([key, cfg]) => {
            const Icon = cfg.icon
            const active = type === key
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => changeType(key)}
                className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium transition-all ${
                  active
                    ? 'bg-primary/15 text-primary shadow-sm ring-1 ring-inset ring-primary/30'
                    : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{cfg.label}</span>
              </button>
            )
          })}
        </div>
      </Field>

      {type !== 'avatar' && (
        <div className="mt-4 space-y-2">
          <Label htmlFor="studio-prompt" className="block text-sm font-medium">
            What do you want to create?
          </Label>
          <Textarea
            id="studio-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void generate()
              }
            }}
            rows={4}
            placeholder={type === 'transcription'
              ? 'Optional vocabulary, speaker names, timestamp style, or context...'
              : 'A vertical hero frame for a product launch teaser, dark cinematic lighting...'}
            className="resize-none text-sm"
          />
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Try:</span>
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion.label}
                type="button"
                onClick={() => {
                  setPrompt(suggestion.prompt)
                  changeType(suggestion.type)
                }}
                className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground/80 transition-colors hover:border-primary/40 hover:bg-muted"
              >
                {suggestion.label}
              </button>
            ))}
          </div>
          {type === 'transcription' && (
            <p className="text-xs text-muted-foreground">
              Optional — biases the transcript's spelling, vocabulary, and speaker names. It isn't an instruction for the model to follow.
            </p>
          )}
        </div>
      )}

      {type === 'avatar' && (
        <AvatarComposer
          audioUrl={avatarAudioUrl}
          imageUrl={avatarImageUrl}
          avatarId={avatarId}
          onAudioUrlChange={setAvatarAudioUrl}
          onImageUrlChange={setAvatarImageUrl}
          onAvatarIdChange={setAvatarId}
        />
      )}
      {type === 'transcription' && (
        <TranscriptionComposer
          audioUrl={transcriptionAudioUrl}
          language={transcriptionLanguage}
          onAudioUrlChange={setTranscriptionAudioUrl}
          onLanguageChange={setTranscriptionLanguage}
        />
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field
          label="Model"
          htmlFor="studio-media-model"
          className={`space-y-1.5 ${hasInlineParams ? '' : 'sm:col-span-2'}`}
        >
          <Select
            value={selectedModel || undefined}
            onValueChange={(value) => setSelectedModels((current) => ({ ...current, [type]: value }))}
            disabled={mediaModelsLoading || Boolean(mediaModelsError) || modelsForType.length === 0}
          >
            <SelectTrigger id="studio-media-model" className="h-9 w-full">
              <SelectValue placeholder={mediaModelsLoading ? 'Loading models…' : 'Select a model'} />
            </SelectTrigger>
            <SelectContent>
              {modelsForType.map((model) => (
                <SelectItem key={model.id} value={model.id} disabled={model.status === 'unavailable'}>
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="truncate">
                      {model.name || model.id}{model.provider ? ` · ${model.provider}` : ''}
                    </span>
                    {model.status !== 'available' && (
                      <span className="shrink-0 text-[10px] capitalize text-muted-foreground">{model.status}</span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {type === 'image' && (
          <ImageComposer
            size={size}
            quality={quality}
            imageCount={imageCount}
            onSizeChange={setSize}
            onQualityChange={setQuality}
            onImageCountChange={setImageCount}
          />
        )}
        {type === 'video' && (
          <VideoComposer
            duration={duration}
            resolution={resolution}
            aspectRatio={aspectRatio}
            referenceImageUrl={referenceImageUrl}
            onDurationChange={setDuration}
            onResolutionChange={setResolution}
            onAspectRatioChange={setAspectRatio}
            onReferenceImageUrlChange={setReferenceImageUrl}
          />
        )}
        {type === 'speech' && (
          <SpeechComposer voice={voice} onVoiceChange={setVoice} />
        )}
      </div>

      {(mediaModelsError || modelMessage(selectedModelOption, mediaModelsLoading, modelsForType.length)) && (
        <p className={`mt-2 text-xs ${mediaModelsError || selectedModelOption?.status === 'unavailable' ? 'text-destructive' : 'text-muted-foreground'}`}>
          {mediaModelsError ?? modelMessage(selectedModelOption, mediaModelsLoading, modelsForType.length)}
        </p>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-4 space-y-2">
        <ComposerDisclosure summary="Advanced options">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Negative prompt">
              <Textarea
                value={negativePrompt}
                onChange={(event) => setNegativePrompt(event.target.value)}
                rows={2}
                placeholder="Avoid artifacts, off-style composition..."
              />
            </Field>
            <Field label="Save to">
              <Input value={outputPath} onChange={(event) => setOutputPath(event.target.value)} />
            </Field>
            {type === 'transcription' && (
              <TranscriptionOptions
                responseFormat={transcriptionResponseFormat}
                temperature={transcriptionTemperature}
                onResponseFormatChange={setTranscriptionResponseFormat}
                onTemperatureChange={setTranscriptionTemperature}
              />
            )}
          </div>
        </ComposerDisclosure>

        <ComposerDisclosure
          summary={(
            <>
              Schedule a post
              {selectedConnectedDestinations.length > 0 && (
                <Badge variant="outline" className="ml-1 text-[10px]">
                  {selectedConnectedDestinations.length}
                </Badge>
              )}
            </>
          )}
        >
          <PublishPackageComposer
            caption={caption}
            postDescription={postDescription}
            mentions={mentions}
            cadence={cadence}
            selectedDestinations={selectedDestinations}
            connections={integrations.connections}
            connectionError={integrations.error}
            connectionsLoading={integrations.isLoading}
            integrationsHref={integrationsHref}
            canManageIntegrations={canManageIntegrations}
            onCaptionChange={setCaption}
            onDescriptionChange={setPostDescription}
            onMentionsChange={setMentions}
            onCadenceChange={setCadence}
            onDestinationToggle={(destination) => {
              const destinationConfig = DESTINATIONS.find((item) => item.id === destination)
              if (!destinationConfig || !isDestinationConnected(destinationConfig, integrations.connections)) return
              setSelectedDestinations((current) => current.includes(destination)
                ? current.filter((item) => item !== destination)
                : [...current, destination])
            }}
          />
        </ComposerDisclosure>
      </div>

      <Button onClick={generate} disabled={!canSubmit} size="lg" className="mt-4 w-full">
        <Sparkles className="mr-2 h-4 w-4" />
        Generate
        <span className="ml-2 text-[10px] opacity-60">⌘↵</span>
      </Button>
    </section>
  )
}
