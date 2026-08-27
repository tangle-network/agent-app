/**
 * The studio composer: one chat-shaped card — prompt, media-type switch, and a
 * band of option pills — that replaces the stacked field panel.
 *
 * The whole point of the rework is that the CONTROLS ARE THE MODEL'S OWN. A pill
 * renders only when the selected model publishes that parameter, its choices are
 * the published enum (or the published range), and the value goes onto the wire
 * exactly as published — seedance takes the string `'5'`, veo `'8s'`, kling the
 * number `5`, and coercing any of them is a 400 from the provider. A model that
 * publishes nothing (`ltx-video`) shows the model pill and nothing else: the
 * honest reading of "we do not know what this takes" is an absent control, not
 * an invented one and not a disabled one.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  ArrowUp,
  Clock,
  Copy,
  Gauge,
  Image as ImageIcon,
  Mic,
  Monitor,
  Ratio,
  Scaling,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Video,
  type LucideIcon,
} from 'lucide-react'
import {
  type Generation,
  type MediaModelCatalogResponse,
  type MediaModelOption,
  type ModelOptionMetadata,
  type ModelOptionValue,
  type ModelOptionsMetadata,
  aspectRatioFromOptions,
  buildGenerationRequestBody,
  curateComposerModels,
  failedOptimisticGeneration,
  imageToVideoSibling,
  laneUnavailable,
  normalizeImageCount,
  optimisticGeneration,
  optionChoices,
  preferredModelId,
  reconcileOptionValues,
  resolveComposerOptions,
  supportsCustomImageSize,
  textToVideoSibling,
  userSafeGenerationMessage,
} from '../studio'
import {
  AudioTogglePill,
  ComposerBand,
  CustomSizeForm,
  MediaTypeSegments,
  ModelPill,
  OptionPill,
  ReferencePill,
  type MediaTypeSegment,
  type OptionChoice,
  optionValueLabel,
} from './composer-option-controls'
import {
  loadComposerSelections,
  saveComposerSelections,
  type PersistedComposerSelections,
} from './composer-persistence'

/** The lanes the composer offers. Avatar and transcription stay disabled
 *  (#451); "Audio" is the word for the `speech` lane everywhere on screen. */
export type ComposerType = 'image' | 'video' | 'speech'

const SEGMENTS: readonly MediaTypeSegment<ComposerType>[] = [
  { type: 'image', label: 'Image', icon: ImageIcon },
  { type: 'video', label: 'Video', icon: Video },
  { type: 'speech', label: 'Audio', icon: AudioLines },
]

/** Pill order per lane. A parameter absent from the model's metadata, or marked
 *  `supported: false`, drops out of the row entirely. */
const PILL_ORDER: Record<ComposerType, readonly string[]> = {
  image: ['size', 'quality', 'n'],
  video: ['duration', 'resolution', 'aspect_ratio', 'mode'],
  speech: ['voice', 'speed'],
}

const PARAM_LABELS: Record<string, string> = {
  size: 'Size',
  quality: 'Quality',
  n: 'Count',
  duration: 'Duration',
  resolution: 'Resolution',
  aspect_ratio: 'Aspect',
  mode: 'Mode',
  voice: 'Voice',
  speed: 'Speed',
}

const PARAM_ICONS: Record<string, LucideIcon> = {
  size: Scaling,
  quality: Sparkles,
  n: Copy,
  duration: Clock,
  resolution: Monitor,
  aspect_ratio: Ratio,
  mode: SlidersHorizontal,
  voice: Mic,
  speed: Gauge,
}

/**
 * Speed is published as a continuous range (0.25–4.0 on OpenAI's endpoint), and
 * a range is not a menu: enumerating it at the step a user would actually pick
 * is 376 rows. These are the presets, filtered against whatever range the model
 * publishes, so a narrower range can never offer a speed it rejects.
 */
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4] as const

function choicesFor(param: string, meta: ModelOptionMetadata): readonly ModelOptionValue[] {
  const { min, max } = meta
  if (param === 'speed' && !meta.values && min != null && max != null) {
    return SPEED_PRESETS.filter((speed) => speed >= min && speed <= max)
  }
  return optionChoices(meta)
}

/** The parameters a lane renders, in order, skipping unknown and unsupported
 *  ones. `audio` and the reference image are not in here — neither is a value
 *  menu. */
function visibleParams(type: ComposerType, options: ModelOptionsMetadata | undefined): string[] {
  if (!options) return []
  return PILL_ORDER[type].filter((param) => {
    const meta = options[param]
    return Boolean(meta) && meta?.supported !== false
  })
}

/**
 * The lane's model. The catalog's own default wins when it survives curation;
 * otherwise the first curated model does — a default that #449 curation removed
 * (a Sora model, a non-gpt-image-2 image model) must not leave the lane with a
 * selection its own menu does not offer.
 */
function defaultModelId(
  type: ComposerType,
  catalog: MediaModelCatalogResponse | null,
  curated: readonly MediaModelOption[],
): string {
  const preferred = preferredModelId(type, catalog)
  if (preferred && curated.some((model) => model.id === preferred && model.status !== 'unavailable')) return preferred
  return curated.find((model) => model.status !== 'unavailable')?.id ?? curated[0]?.id ?? ''
}

export interface StudioComposerProps {
  workspaceId?: string
  onGenerated: (generation: Generation) => void
  /** `home` (under a page heading) vs `docked` (pinned under a generation).
   *  Presentational only — the card itself is identical either way. */
  variant?: 'home' | 'docked'
  /** Pick or upload a reference image, resolving to a URL or `null` on cancel.
   *  Without it the Reference pill takes a URL instead, which is the most a host
   *  with no upload endpoint can honestly offer. */
  pickReferenceImage?: () => Promise<string | null>
  /** Circular Generate button colour. `contrast` (default) preserves the
   *  inverted foreground/background canon; `primary` uses host brand tokens. */
  sendTone?: 'contrast' | 'primary'
  className?: string
}

/**
 * The composer card. The host owns its width (the card fills its container) and
 * the heading above it; this owns the prompt, the controls, and the POST.
 */
export function StudioComposer({
  workspaceId,
  onGenerated,
  variant = 'home',
  pickReferenceImage,
  sendTone = 'contrast',
  className,
}: StudioComposerProps) {
  const [type, setType] = useState<ComposerType>('image')
  const [prompt, setPrompt] = useState('')
  const [catalog, setCatalog] = useState<MediaModelCatalogResponse | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [selectedModels, setSelectedModels] = useState<Partial<Record<ComposerType, string>>>({})
  const [optionValues, setOptionValues] = useState<Record<ComposerType, Record<string, ModelOptionValue>>>({
    image: {},
    video: {},
    speech: {},
  })
  const [referenceImageUrl, setReferenceImageUrl] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hydratedWorkspaceId, setHydratedWorkspaceId] = useState<string | null>(null)
  const submitLockRef = useRef(false)
  const bandRef = useRef<HTMLDivElement>(null)
  const hydratedRef = useRef(false)
  const persistedOptionsRef = useRef<PersistedComposerSelections['optionsByModel']>({})

  useEffect(() => {
    hydratedRef.current = false
    setHydratedWorkspaceId(null)
    if (!workspaceId) return
    const persisted = loadComposerSelections(workspaceId)
    if (persisted) {
      setType(persisted.type)
      setSelectedModels(persisted.selectedModels)
      persistedOptionsRef.current = persisted.optionsByModel
    } else {
      persistedOptionsRef.current = {}
    }
    hydratedRef.current = true
    setHydratedWorkspaceId(workspaceId)
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    setCatalogLoading(true)
    setCatalogError(null)

    fetch(`/api/media-models?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(async (res) => {
        const data = await res.json() as MediaModelCatalogResponse
        if (!res.ok) throw new Error(data.error ?? 'Could not load media models')
        return data
      })
      .then((data) => {
        if (cancelled) return
        setCatalog(data)
      })
      .catch(() => {
        if (cancelled) return
        setCatalog(null)
        // Never surface the raw fetch/parse error — a non-JSON 404 page reads
        // as `Unexpected token 'N', "Not Found" is not valid JSON` to users.
        setCatalogError('Could not load media models')
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const laneModels = useMemo(() => catalog?.models[type] ?? [], [catalog, type])
  const curatedModels = useMemo(() => curateComposerModels(type, laneModels), [laneModels, type])
  // A retained pick survives only while the CURRENT catalog can honour it: with
  // no catalog yet keep it; an intentionally-uncurated i2v sibling stays (it is
  // reached by attaching a reference, never listed); anything else must be
  // present in the curated list, or the lane falls back to its
  // default. The deleted ComposerHero defended this via selectedModelsWithDefaults;
  // that helper resolves over the FULL catalog and would resurrect
  // curation-removed defaults, so the guard is re-derived here over curatedModels.
  const retained = selectedModels[type]
  const retainedUsable = retained !== undefined && (
    !catalog
    || Boolean(textToVideoSibling(retained))
    || curatedModels.some((model) => model.id === retained)
  )
  const modelId = retainedUsable ? retained : defaultModelId(type, catalog, curatedModels)
  // The image-to-video sibling is deliberately absent from the curated menu (it
  // is reached by attaching a reference image), so the row backing the pill is
  // looked up in the FULL lane list and may still be missing — a sibling the
  // catalog does not carry is sent by id and displayed as its id.
  const modelOption = laneModels.find((model) => model.id === modelId)

  // A dead selection is honoured only while the user is looking at it: a catalog
  // (re)load or a lane switch re-resolves to the first available model, so a dead
  // default never stays selected on its own (#463). A menu pick of an unavailable
  // model after that still sticks — until the catalog or the lane changes again.
  useEffect(() => {
    setSelectedModels((current) => {
      const retainedId = current[type]
      if (!retainedId || !catalog) return current
      // Never prune the image-to-video sibling: it is reached only by attaching a
      // reference (never menu-listed), and pruning it would fall back to the t2v
      // parent with the reference still attached — a reference on a text-to-video
      // request. An unavailable sibling instead keeps the warned pill and the
      // modelReady send gate, exactly the pre-#463 behavior.
      if (textToVideoSibling(retainedId)) return current
      const row = (catalog.models[type] ?? []).find((model) => model.id === retainedId)
      if (!row || row.status !== 'unavailable') return current
      const next = { ...current }
      delete next[type]
      return next
    })
  }, [catalog, type])

  const options = useMemo(
    () => (modelId
      ? resolveComposerOptions({
        type,
        modelId,
        provider: modelOption?.provider,
        catalogOptions: modelOption?.options,
      })
      : undefined),
    [modelId, modelOption, type],
  )

  // Re-reconcile whenever the resolved options change: a selection the new model
  // still accepts survives, an illegal one resets to that model's default, and a
  // parameter it does not publish is dropped rather than carried invisibly.
  useEffect(() => {
    setOptionValues((current) => {
      const seed = { ...persistedOptionsRef.current[modelId], ...current[type] }
      const next = reconcileOptionValues(options, seed, {
        allowCustomSize: supportsCustomImageSize(modelId),
      })
      const unchanged = Object.keys(next).length === Object.keys(current[type]).length
        && Object.entries(next).every(([key, value]) => current[type][key] === value)
      return unchanged ? current : { ...current, [type]: next }
    })
  }, [modelId, options, type])

  useEffect(() => {
    if (!workspaceId || !hydratedRef.current || hydratedWorkspaceId !== workspaceId) return
    // An unknown pre-catalog model has no vocabulary to validate against yet;
    // keep its stored options intact until the catalog resolves. Known models
    // can reconcile immediately from their built-in option metadata.
    if (!catalog && modelId && persistedOptionsRef.current[modelId] !== undefined && !options) return
    const seed = { ...persistedOptionsRef.current[modelId], ...optionValues[type] }
    const reconciled = reconcileOptionValues(options, seed, {
      allowCustomSize: supportsCustomImageSize(modelId),
    })
    const reconciledReady = Object.keys(reconciled).length === Object.keys(optionValues[type]).length
      && Object.entries(reconciled).every(([key, value]) => optionValues[type][key] === value)
    if (!reconciledReady) return
    const optionsByModel = {
      ...persistedOptionsRef.current,
      ...(modelId ? { [modelId]: optionValues[type] } : {}),
    }
    saveComposerSelections(workspaceId, {
      v: 1,
      type,
      selectedModels,
      optionsByModel,
    })
    persistedOptionsRef.current = optionsByModel
  }, [catalog, hydratedWorkspaceId, modelId, optionValues, options, selectedModels, type, workspaceId])

  const laneDown = Boolean(catalog) && !catalogLoading && !catalogError && laneUnavailable(curatedModels)

  const values = optionValues[type]
  // Every parameter belongs to the MODEL. A dead lane has none, so the pills it
  // would have filled are dropped rather than left standing on a default no
  // model is offering.
  const params = laneDown ? [] : visibleParams(type, options)
  const audioMeta = type === 'video' ? options?.audio : undefined
  const audioSupported = !laneDown && Boolean(audioMeta) && audioMeta?.supported !== false
  // A model the catalog does not list is normally "not ready" — except for a
  // verified image-to-video sibling, which the composer selected itself by
  // attaching a reference image and must be able to send even when the catalog
  // never listed it.
  const unlistedSibling = !modelOption && Boolean(textToVideoSibling(modelId))
  const referenceSupported = !laneDown
    && type === 'video'
    && Boolean(imageToVideoSibling(modelId) ?? textToVideoSibling(modelId))

  const modelReady = (Boolean(modelOption) || unlistedSibling)
    && modelOption?.status !== 'unavailable'
    && !catalogLoading
    && !catalogError
  const canSubmit = Boolean(workspaceId) && modelReady && Boolean(prompt.trim()) && !isSubmitting

  function selectModel(id: string) {
    setSelectedModels((current) => ({ ...current, [type]: id }))
  }

  /** The model MENU's handler. While a reference is attached the selection must
   *  keep the attachment ⇒ image-to-video invariant: a reference-capable pick is
   *  re-mapped to its i2v sibling, and a pick with no sibling drops the
   *  attachment explicitly rather than hiding it to reappear later. */
  function chooseModel(id: string) {
    if (!referenceImageUrl || type !== 'video') return selectModel(id)
    const sibling = imageToVideoSibling(id)
    if (sibling) return selectModel(sibling)
    if (!textToVideoSibling(id)) setReferenceImageUrl(null)
    return selectModel(id)
  }

  function setOption(param: string, value: ModelOptionValue) {
    setOptionValues((current) => ({ ...current, [type]: { ...current[type], [param]: value } }))
  }

  function attachReference(url: string) {
    setReferenceImageUrl(url)
    const sibling = imageToVideoSibling(modelId)
    if (sibling) selectModel(sibling)
  }

  function removeReference() {
    setReferenceImageUrl(null)
    const sibling = textToVideoSibling(modelId)
    if (sibling) selectModel(sibling)
  }

  async function generate() {
    if (!workspaceId || submitLockRef.current || isSubmitting) return
    const promptText = prompt.trim()
    if (!promptText) return
    if (!modelReady) return
    submitLockRef.current = true
    setIsSubmitting(true)
    setError(null)

    const clientRequestId = crypto.randomUUID()
    const imageCount = type === 'image' ? normalizeImageCount(values.n ?? 1) : 1
    const localGenerations = Array.from({ length: imageCount }, (_, outputIndex) => optimisticGeneration(
      {
        type,
        prompt: promptText,
        model: modelId,
        clientRequestId,
        outputIndex: type === 'image' ? outputIndex : undefined,
        outputCount: type === 'image' ? imageCount : undefined,
      },
      aspectRatioFromOptions(type, {
        size: asText(values.size),
        aspectRatio: asText(values.aspect_ratio),
      }),
    ))
    localGenerations.slice().reverse().forEach(onGenerated)
    setPrompt('')

    let receivedServerGeneration = false
    try {
      const body = buildGenerationRequestBody({
        workspaceId,
        clientRequestId,
        type,
        model: modelId,
        prompt: promptText,
        // `duration`, `audio` and `speed` go on the wire in the TYPE the model
        // published them in — a `duration` of `'5'` that arrives as `5` is a
        // different request, and the three providers behind this lane disagree
        // about which is right. An absent value is omitted, never defaulted.
        image: {
          size: asText(values.size),
          quality: asText(values.quality),
          count: imageCount,
        },
        video: {
          duration: asWireScalar(values.duration),
          resolution: asText(values.resolution),
          aspectRatio: asText(values.aspect_ratio),
          referenceImageUrl: referenceSupported && referenceImageUrl ? referenceImageUrl : undefined,
          audio: audioSupported && typeof values.audio === 'boolean' ? values.audio : undefined,
          mode: asText(values.mode),
        },
        speech: {
          voice: asText(values.voice),
          speed: typeof values.speed === 'number' ? values.speed : undefined,
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
      if (!res.ok || serverGenerations.length === 0) throw new Error(data.error ?? 'Generation failed')
    } catch (err) {
      if (!receivedServerGeneration) localGenerations.map(failedOptimisticGeneration).forEach(onGenerated)
      setError(err instanceof Error ? userSafeGenerationMessage(err.message) : 'Generation failed')
    } finally {
      submitLockRef.current = false
      setIsSubmitting(false)
    }
  }

  const notice = catalogError ?? error
  const laneLabel = SEGMENTS.find((segment) => segment.type === type)!.label
  // An empty curated lane can reflect catalog or curation policy, not an outage.
  const laneDownMessage = curatedModels.length > 0
    ? `${laneLabel} models are temporarily unavailable`
    : `No ${laneLabel.toLowerCase()} models are available`

  return (
    <section
      data-variant={variant}
      className={`studio-composer-card rounded-2xl border border-border bg-surface-container-high p-2.5 shadow-sm transition focus-within:border-primary/60 ${className ?? ''}`}
    >
      {laneDown ? (
        <p className="flex min-h-0 items-center gap-2 px-1.5 pb-3 pt-1.5 text-[13px] font-medium text-warning">
          <TriangleAlert aria-hidden className="h-4 w-4 shrink-0" strokeWidth={2} />
          <span>{laneDownMessage}</span>
        </p>
      ) : (
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            event.preventDefault()
            void generate()
          }}
          rows={3}
          aria-label="Prompt"
          placeholder="Describe what you want to generate…"
          className="block min-h-[66px] w-full resize-none border-0 bg-transparent px-1.5 pb-1 pt-1.5 text-[14.5px] leading-relaxed outline-none placeholder:text-muted-foreground"
        />
      )}

      <div className="flex items-center gap-2">
        <MediaTypeSegments value={type} segments={SEGMENTS} onChange={setType} />

        <ComposerBand bandRef={bandRef} resetKey={type}>
          <ModelPill
            models={curatedModels}
            // A dead lane has no sendable model, so nothing in the menu is marked
            // chosen either — the resolved default is a placeholder, not a pick.
            value={laneDown ? '' : modelId}
            // The pill names none for the same reason: a model name there reads as a
            // working choice the user could send.
            displayName={laneDown ? 'Unavailable' : modelOption?.name || modelId || 'Select a model'}
            provider={laneDown ? undefined : modelOption?.provider}
            unavailable={laneDown || modelOption?.status === 'unavailable'}
            onSelect={chooseModel}
            bandRef={bandRef}
          />

          {params.map((param) => (
            <div key={`${type}-${param}`} className="studio-pill-in flex-none">
              <OptionPill
                label={PARAM_LABELS[param] ?? param}
                icon={PARAM_ICONS[param] ?? SlidersHorizontal}
                value={values[param]}
                choices={choicesForPill(param, options?.[param], values[param])}
                onSelect={(value) => setOption(param, value)}
                bandRef={bandRef}
                custom={param === 'size' && supportsCustomImageSize(modelId)
                  ? {
                    label: 'Custom…',
                    render: ({ close }) => (
                      <CustomSizeForm
                        initial={asText(values.size)}
                        onApply={(size) => {
                          setOption('size', size)
                          close()
                        }}
                        onCancel={close}
                      />
                    ),
                  }
                  : undefined}
              />
            </div>
          ))}

          {audioSupported && (
            <div key={`${type}-audio`} className="studio-pill-in flex-none">
              <AudioTogglePill
                on={values.audio === true}
                onToggle={(on) => setOption('audio', on)}
              />
            </div>
          )}

          {referenceSupported && (
            <div key={`${type}-reference`} className="studio-pill-in flex-none">
              <ReferencePill
                url={referenceImageUrl}
                onAttach={attachReference}
                onRemove={removeReference}
                pick={pickReferenceImage}
                bandRef={bandRef}
              />
            </div>
          )}
        </ComposerBand>

        <button
          type="button"
          aria-label="Generate"
          title="Generate"
          disabled={!canSubmit}
          onClick={() => void generate()}
          className={`ml-auto inline-flex h-8 w-8 flex-none items-center justify-center rounded-full ${sendTone === 'primary' ? 'bg-primary text-primary-foreground' : 'bg-foreground text-background'} transition ${sendTone === 'primary' ? 'hover:bg-primary/90' : 'hover:opacity-90'} disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card`}
        >
          <ArrowUp className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>

      {notice && (
        <p className="px-1.5 pt-1.5 text-[12px] text-destructive">
          {notice}
        </p>
      )}
    </section>
  )
}

/** A text-typed field's value, or `undefined` so the field is omitted entirely
 *  — `String(undefined)` puts the literal `"undefined"` on the wire, which the
 *  provider will try to honour. These fields are typed `string` by the
 *  `/api/generate` contract, so a numeric published value is rendered as its
 *  digits; the type-sensitive fields (`duration`, `audio`, `speed`) never pass
 *  through here. */
function asText(value: ModelOptionValue | undefined): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined
}

/** A duration passes through as published: the string `'5'`, the string `'8s'`,
 *  or the number `5`. Only a boolean (which no lane publishes here) is refused. */
function asWireScalar(value: ModelOptionValue | undefined): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

/** The pill's rows: the published choices, plus the current value when it is a
 *  legal off-enum one (a custom gpt-image-2 size), so the pill reports what is
 *  actually selected instead of falling back to a dash. */
function choicesForPill(
  param: string,
  meta: ModelOptionMetadata | undefined,
  value: ModelOptionValue | undefined,
): OptionChoice[] {
  if (!meta) return []
  const choices = choicesFor(param, meta).map((choice) => ({
    value: choice,
    label: optionValueLabel(param, choice),
  }))
  if (value === undefined || choices.some((choice) => choice.value === value)) return choices
  return [...choices, { value, label: `${optionValueLabel(param, value)} · custom` }]
}
