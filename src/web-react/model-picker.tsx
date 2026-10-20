/** Searchable catalog selection and truthful model price presentation. */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ProviderLogo } from './provider-logo'
import { StatusPill } from '@tangle-network/ui/primitives'
import { MAX_RECOMMENDED_MODELS, sortModelsByFreshness, type CatalogModel } from '../runtime/model-catalog'
import { ChevronDown, CheckGlyph, SearchGlyph, SparkleGlyph } from './control-glyphs'
import { usePopover, PopoverSurface } from './popover-surface'
import { CHIP_PICKER_TRIGGER, OVERLAY_SHADOW, POPOVER_OPTION_FOCUS, pickerRootClass, fieldPickerTriggerClass, quietPickerTriggerClass, type PickerVariant } from './picker-presentation'

export interface ModelPickerProps {
  /** Controlled, opaque saved id. Never replaced merely because the catalogue omits it. */
  value: string
  onChange: (id: string) => void
  /** Catalogue models — from `GET`ing the app's catalogue route (see
   *  `runtime/model-catalog`), plus any product-specific entries appended. */
  models: CatalogModel[]
  /** Host-owned request state. Loading takes precedence over error and results. */
  loading?: boolean
  /** Host-safe failure message. null/undefined means no failure; even '' is an error. */
  error?: string | null
  /** Ask the host to retry. The host owns fetching, loading, errors and cancellation. */
  onRetry?: () => void
  /** Disable the trigger and close an open picker; does not change the saved value. */
  disabled?: boolean
  /** Associations belong to the trigger button, not its surrounding div. */
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  /** Render a provider logo/badge; default is ProviderLogo. */
  renderProviderBadge?: (provider: string) => ReactNode
  /** Section label for `featured` models. */
  recommendedLabel?: string
  /** Pin a labeled section to the TOP of the list (above Recommended) for the
   *  models a product wants surfaced first — e.g. a tuner app's own fine-tuned
   *  models (`{ label: 'Your Fine-Tuned Models', match: (m) => m.provider === 'tuner' }`).
   *  Matching models are shown only in this section, not duplicated below. */
  priorityGroup?: {
    label: string
    match: (model: CatalogModel) => boolean
  }
  /** Trigger treatment — see {@link PickerVariant}. Default `chip`. */
  variant?: PickerVariant
  /** Optional accessible trigger content for a picker docked beside an editable model field. */
  triggerContent?: ReactNode
  /**
   * Offer "no selection" as the first row, for a setting that may defer to a
   * default chosen elsewhere. Choosing it calls `onChange('')`, and the trigger
   * shows this label while `value` is empty.
   */
  defaultOption?: { label: string }
}

function formatPrice(p?: string): string | undefined {
  if (!p) return undefined
  const n = Number(p)
  if (isNaN(n) || n === 0) return undefined
  const perM = n * 1_000_000
  const amount = Number.isInteger(perM) ? perM.toFixed(0) : perM.toFixed(2)
  return `$${amount}/M`
}

const OUTPUT_UNIT_LABEL: Record<NonNullable<CatalogModel['outputPrice']>['unit'], string> = {
  image: 'image',
  second: 'sec',
  minute: 'min',
  '1k_chars': '1K chars',
}

/**
 * The price a person pays per output, in the unit that output comes in: per
 * million prompt tokens for text, per image, per second of video, per minute of
 * audio, per 1,000 characters of speech. Undefined when the catalogue has no
 * price, so a row never shows a made-up number.
 */
export function formatModelPrice(model: Pick<CatalogModel, 'pricing' | 'outputPrice'>): string | undefined {
  const media = model.outputPrice
  if (media && Number.isFinite(media.usd) && media.usd > 0) {
    const amount = media.usd >= 1 ? media.usd.toFixed(2) : media.usd >= 0.01 ? String(Number(media.usd.toFixed(3))) : media.usd.toPrecision(2)
    return `$${amount}/${OUTPUT_UNIT_LABEL[media.unit]}`
  }
  return formatPrice(model.pricing?.prompt)
}

function formatContext(len?: number): string | undefined {
  if (!len) return undefined
  if (len >= 1_000_000) return `${(len / 1_000_000).toFixed(1)}M ctx`
  if (len >= 1_000) return `${Math.round(len / 1_000)}K ctx`
  return `${len} ctx`
}

/** The brand whose logo a row shows: its maker when the catalogue names one,
 *  else its host. A fal-hosted Veo row shows Google, not fal. */
function logoBrand(model: Pick<CatalogModel, 'provider' | 'maker'>): string {
  return model.maker?.trim() || model.provider
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  )
}

function ModelRow({
  model,
  selected,
  onSelect,
  renderProviderBadge,
}: {
  model: CatalogModel
  selected: boolean
  onSelect: () => void
  renderProviderBadge?: (provider: string) => ReactNode
}) {
  const price = formatModelPrice(model)
  const ctx = formatContext(model.contextLength)
  const media = model.output && model.output !== 'text'
  const thumb = media && (model.output === 'image' || model.output === 'video') ? model.previewUrl : undefined
  const unavailable = model.status === 'unavailable'
  const flagged = unavailable || model.status === 'limited'
  // A flagged model keeps its row and stays selectable; the warning tone, not a
  // grey sentence, says it cannot run as asked.
  const capability = model.capability ?? (flagged ? model.statusReason : undefined)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={`${model.name} (${model.id})`}
      className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm transition ${POPOVER_OPTION_FOCUS} ${
        selected ? 'bg-primary/10 font-medium' : 'hover:bg-accent'
      }`}
    >
      {thumb ? (
        // A media model shows what it makes: a 40px example beside its name.
        <img src={thumb} alt="" loading="lazy" decoding="async" data-model-preview
          className={`size-10 shrink-0 rounded-md border border-border object-cover${unavailable ? ' opacity-50' : ''}`} />
      ) : (
        <span className="shrink-0" aria-hidden>
          {renderProviderBadge ? renderProviderBadge(logoBrand(model)) : <ProviderLogo provider={logoBrand(model)} size={16} />}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          {thumb && (
            <span className="shrink-0" aria-hidden>
              {renderProviderBadge ? renderProviderBadge(logoBrand(model)) : <ProviderLogo provider={logoBrand(model)} size={14} />}
            </span>
          )}
          <span className={`min-w-0 break-words [overflow-wrap:anywhere]${unavailable ? ' text-muted-foreground' : ''}`}>{model.name}</span>
          {flagged && (
            <StatusPill tone="warning" size="sm" className="shrink-0" title={model.statusReason} data-model-status={model.status}>
              {unavailable ? 'Unavailable' : 'Limited'}
            </StatusPill>
          )}
        </span>
        {capability && (
          <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground" data-model-capability>{capability}</span>
        )}
        {(ctx || price || (!media && !model.supportsTools)) && (
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-normal text-muted-foreground">
            {!media && !model.supportsTools && <span className="rounded bg-secondary px-1.5 py-0.5">no tools</span>}
            {!media && ctx && <span>{ctx}</span>}
            {price && <span data-model-price>{price}</span>}
          </span>
        )}
      </span>
      {selected && <CheckGlyph className="h-3.5 w-3.5 shrink-0 text-primary" />}
    </button>
  )
}

/**
 * Searchable model picker pill + popover. A featured model is recommended
 * when the catalog marks it as a current choice. The first view stays short;
 * search and the browse action retain every routeable legacy model.
 *
 * This is the CANONICAL ecosystem model picker (see docs/ui-picker-canon.md).
 * Catalogue requests, retry outcomes and persisted selections belong to the host.
 * The non-modal dialog uses native buttons, not a partial combobox/listbox:
 * Tab and Enter/Space work normally; arrow keys also move through its controls.
 */
export function ModelPicker({
  value, onChange, models, loading = false, error, onRetry, disabled = false,
  id, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, 'aria-describedby': ariaDescribedBy,
  renderProviderBadge, recommendedLabel = 'Recommended', priorityGroup,
  variant = 'chip', triggerContent, defaultOption,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const changeOpen = useCallback((next: boolean) => {
    setOpen(next && !disabled)
    if (!next) {
      setQuery('')
      setShowAll(false)
    }
  }, [disabled])
  const expanded = open && !disabled
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(expanded, changeOpen)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelId = useId()
  const valueId = useId()
  const unavailable = error != null
  const sortedModels = useMemo(() => sortModelsByFreshness(models), [models])
  const contentKey = useMemo(() => ({ query, showAll, loading, error, models, value, priorityGroup }),
    [query, showAll, loading, error, models, value, priorityGroup])

  useEffect(() => {
    if (disabled) changeOpen(false)
  }, [disabled, changeOpen])

  useEffect(() => {
    if (!expanded) return
    // The portal's placement may commit a second render. Focus after that too.
    const focus = () => inputRef.current?.focus()
    focus()
    if (typeof requestAnimationFrame !== 'function') return
    const frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [expanded])

  useEffect(() => {
    const panel = panelRef.current
    if (!expanded || !panel) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
      const input = inputRef.current
      if (!input || !panel) return
      const controls: HTMLElement[] = [input, ...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = controls.indexOf(document.activeElement as HTMLElement)
      if (index < 0) return
      if (event.key === 'Tab') {
        // Portals are last in DOM order. Exit beside the trigger, not at the
        // top of the page; Shift+Tab from search returns to the trigger itself.
        if ((event.shiftKey && index === 0) || (!event.shiftKey && index === controls.length - 1)) {
          changeOpen(false)
          triggerRef.current?.focus()
          if (event.shiftKey) event.preventDefault()
        }
        return
      }
      let next: number
      if (event.key === 'ArrowDown') next = (index + 1) % controls.length
      else if (event.key === 'ArrowUp') next = (index - 1 + controls.length) % controls.length
      else if (event.key === 'Home' && index > 0) next = 1
      else if (event.key === 'End' && index > 0) next = controls.length - 1
      else return // Home/End in search remain text-editing keys.
      event.preventDefault()
      controls[next]?.focus()
    }
    panel.addEventListener('keydown', onKeyDown)
    return () => panel.removeEventListener('keydown', onKeyDown)
  }, [expanded, changeOpen, panelRef, triggerRef])

  const selected = sortedModels.find((m) => m.id === value)
  const selectedLabel = selected?.name ?? value
  const describeValue = triggerContent != null || Boolean(id || ariaLabel || ariaLabelledBy)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return sortedModels.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.description?.toLowerCase() ?? '').includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        (m.maker?.toLowerCase() ?? '').includes(q),
    )
  }, [sortedModels, query])

  const sections = useMemo(() => {
    const isPriority = priorityGroup ? (m: CatalogModel) => priorityGroup.match(m) : () => false
    const priority = priorityGroup ? sortedModels.filter(isPriority) : []
    const featured = sortedModels.filter((model) => model.featured && !isPriority(model))
    const recommended = featured.slice(0, MAX_RECOMMENDED_MODELS)
    const visibleIds = new Set([...priority, ...recommended].map((model) => model.id))
    const currentSelection = sortedModels.find((model) => model.id === value && !visibleIds.has(model.id))
    const byProvider: Array<{ provider: string; items: CatalogModel[] }> = []
    for (const model of sortedModels) {
      if (visibleIds.has(model.id)) continue
      const last = byProvider[byProvider.length - 1]
      if (last && last.provider === model.provider) last.items.push(model)
      else byProvider.push({ provider: model.provider, items: [model] })
    }
    return { priority, recommended, currentSelection, byProvider }
  }, [sortedModels, priorityGroup, value])

  const select = (modelId: string) => {
    if (disabled || (modelId && (loading || unavailable))) return
    changeOpen(false)
    triggerRef.current?.focus()
    onChange(modelId)
  }
  const row = (model: CatalogModel) => (
    <ModelRow key={model.id} model={model} selected={model.id === value} onSelect={() => select(model.id)} renderProviderBadge={renderProviderBadge} />
  )

  return (
    <div ref={containerRef} className={variant === 'field' ? 'relative flex w-full min-w-0' : 'relative inline-flex min-w-0 max-w-full'}>
      <button
        type="button"
        {...triggerProps}
        id={id}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={[ariaDescribedBy, describeValue && value ? valueId : undefined].filter(Boolean).join(' ') || undefined}
        aria-haspopup="dialog"
        aria-controls={expanded ? panelId : undefined}
        onClick={() => changeOpen(!expanded)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            changeOpen(true)
          }
        }}
        title={selectedLabel || defaultOption?.label || 'Select model'}
        data-state={expanded ? 'open' : 'closed'}
        className={`${
          variant === 'field'
            ? fieldPickerTriggerClass({ interactive: !disabled })
            : variant === 'quiet'
            ? quietPickerTriggerClass({ interactive: !disabled })
            : `${CHIP_PICKER_TRIGGER} ${disabled ? '' : 'hover:bg-accent'}`
        } max-w-full disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {triggerContent ?? <span className={variant === 'field' ? 'flex min-w-0 flex-1 items-center gap-2' : 'contents'}>
          <span className="shrink-0" aria-hidden>
            {selected ? (renderProviderBadge ? renderProviderBadge(logoBrand(selected)) : <ProviderLogo provider={logoBrand(selected)} size={16} />) : <SparkleGlyph className="h-3.5 w-3.5 text-muted-foreground" />}
          </span>
          <span className={variant === 'field' ? `min-w-0 flex-1 truncate ${value ? '' : 'text-muted-foreground'}` : 'max-w-[160px] truncate'}>
            {selectedLabel || defaultOption?.label || 'Select model'}</span>
        </span>}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      {describeValue && value && <span id={valueId} className="sr-only">Selected model: {selectedLabel}</span>}

      <PopoverSurface
        open={expanded}
        id={panelId}
        role="dialog"
        aria-label="Choose a model"
        contentKey={contentKey}
        triggerRef={triggerRef}
        panelRef={panelRef}
        matchTriggerWidth={variant === 'field'}
        side={variant === 'field' ? 'below' : undefined}
        className={`flex w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-card-edge bg-popover text-foreground ${OVERLAY_SHADOW}`}
      >
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 rounded-lg border border-strong bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-ring">
            <SearchGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models..."
              aria-label="Search all models"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
        {/* min-h-0 lets results absorb the surface's viewport height limit. */}
        <div className="max-h-[520px] min-h-0 overflow-y-auto p-1 pb-2">
          {defaultOption && !query.trim() && (
            <button
              type="button"
              onClick={() => select('')}
              aria-pressed={!value}
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm transition ${POPOVER_OPTION_FOCUS} ${
                value ? 'hover:bg-accent' : 'bg-primary/10 font-medium'
              }`}
            >
              <SparkleGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">{defaultOption.label}</span>
              {!value && <CheckGlyph className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>
          )}
          {value && !selected && (
            <div className="mx-2 mb-1 mt-2 rounded-lg bg-secondary px-3 py-2 text-sm">
              <p className="text-xs font-medium text-muted-foreground">Saved model</p>
              <p className="break-words [overflow-wrap:anywhere]">{value}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {loading || unavailable ? 'Your saved selection is unchanged.' : 'Not in this catalogue. Your saved selection is unchanged.'}
              </p>
            </div>
          )}
          {loading ? (
            <div role="status" className="px-3 py-4 text-center text-sm text-muted-foreground">Loading models...</div>
          ) : unavailable ? (
            <div className="px-3 py-4 text-sm">
              <div role="alert">
                <p className="font-medium">Model catalogue unavailable</p>
                <p className="mt-1 break-words text-muted-foreground [overflow-wrap:anywhere]">{error || 'The catalogue could not be loaded.'}</p>
              </div>
              {onRetry && <button type="button" className={`mt-3 rounded-md border border-border bg-card px-3 py-2 font-medium hover:bg-accent ${POPOVER_OPTION_FOCUS}`}
                onClick={() => {
                  // Retry may remove this button synchronously. Keep focus on
                  // the stable search input while the host updates its state.
                  inputRef.current?.focus()
                  onRetry()
                }}>Retry</button>}
            </div>
          ) : models.length === 0 ? (
            <div role="status" className="px-3 py-4 text-center text-sm text-muted-foreground">No models available</div>
          ) : filtered ? (
            <>
              {filtered.length === 0 && <div role="status" className="px-3 py-4 text-center text-sm text-muted-foreground">No models match your search</div>}
              {filtered.map(row)}
            </>
          ) : (
            <>
              {priorityGroup && sections.priority.length > 0 && <>
                <SectionHeader>{priorityGroup.label}</SectionHeader>
                {sections.priority.map(row)}
              </>}
              {sections.currentSelection && !showAll && <>
                <SectionHeader>Selected model</SectionHeader>
                {row(sections.currentSelection)}
              </>}
              {sections.recommended.length > 0 && <>
                <SectionHeader>{recommendedLabel}</SectionHeader>
                {sections.recommended.map(row)}
              </>}
              {sections.recommended.length === 0 && sections.priority.length === 0 && !sections.currentSelection && (
                <div className="px-3 py-3 text-sm text-muted-foreground">Search or browse all models</div>
              )}
              {sections.byProvider.length > 0 && <button
                type="button"
                aria-expanded={showAll}
                onClick={() => setShowAll(!showAll)}
                className={`mt-2 w-full rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground ${POPOVER_OPTION_FOCUS}`}
              >{showAll ? 'Hide older models' : 'Browse all models'}</button>}
              {showAll && sections.byProvider.map((group) => (
                <div key={group.provider}>
                  <SectionHeader>{group.provider}</SectionHeader>
                  {group.items.map(row)}
                </div>
              ))}
            </>
          )}
        </div>
      </PopoverSurface>
    </div>
  )
}
