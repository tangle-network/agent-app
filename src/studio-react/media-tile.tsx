import {
  Check,
  Download,
  FileText,
  FolderOpen,
  FolderPlus,
  Pause,
  Play,
  Trash2,
} from 'lucide-react'
import {
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useState,
} from 'react'

import { hashSeed, previewWaveformBars } from '../studio/audio-preview'
import {
  generationError,
  generationSavedToVault,
  generationStatus,
  generationVaultPath,
  isLocalGeneration,
  type Generation,
} from '../studio/generation'
import type { StudioMediaActions, VaultSaveResult } from '../studio/ports'
import { usePopover } from '../web-react/controls'
import { VaultPathPopover } from './vault-path-popover'
import { downloadGenerationsViaAnchor } from './download-generations'
import { useStudioPlayback } from './studio-playback'

export interface MediaTileProps {
  generation: Generation
  context: 'home' | 'generation' | 'history'
  onOpen: (generation: Generation) => void
  actions?: StudioMediaActions
  /** Generation screen passes the batch aspect; omitted → square. */
  aspectRatio?: number
  /** 26 for grids (default), 72 for wide generation/viewer tiles. */
  waveformBars?: number
  selectMode?: boolean
  selected?: boolean
  onToggleSelect?: (id: string) => void
  onRequestDelete?: (generation: Generation) => void
  onSaved?: (results: readonly VaultSaveResult[]) => void
  className?: string
  style?: CSSProperties
}

type TileStyle = CSSProperties & { '--r'?: number }

function stop(event: MouseEvent<HTMLElement>): void {
  event.stopPropagation()
}

export function MediaTile({
  generation,
  context,
  onOpen,
  actions,
  aspectRatio,
  waveformBars = 26,
  selectMode = false,
  selected = false,
  onToggleSelect,
  onRequestDelete,
  onSaved,
  className,
  style,
}: MediaTileProps): JSX.Element {
  const playback = useStudioPlayback()
  const [waveNode, setWaveNode] = useState<HTMLDivElement | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(saveOpen, setSaveOpen)
  const vaultPath = generationVaultPath(generation)
  const savedToVault = generationSavedToVault(generation)
  const status = generationStatus(generation)
  const canSaveToVault = status === 'succeeded' && !isLocalGeneration(generation)
  const isSpeech = generation.type === 'speech'
  const isPlaying = isSpeech && playback.activeId === generation.id && playback.playing

  useEffect(() => playback.registerPositionNode(generation.id, waveNode), [
    generation.id,
    playback.registerPositionNode,
    waveNode,
  ])

  const classes = [
    'studio-tile relative isolate m-0 cursor-pointer overflow-hidden rounded-none border-0 bg-accent',
    aspectRatio === undefined ? 'aspect-square' : '',
    'focus-visible:[outline-offset:-2px]',
    isSpeech ? 'studio-has-player' : '',
    selectMode ? 'studio-selectmode' : '',
    selected ? 'outline outline-2 -outline-offset-2 outline-primary' : '',
    className ?? '',
  ].filter(Boolean).join(' ')
  const tileStyle: TileStyle = aspectRatio === undefined
    ? { ...style }
    : { ...style, aspectRatio, '--r': aspectRatio }

  function activate(): void {
    if (selectMode) onToggleSelect?.(generation.id)
    else onOpen(generation)
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    activate()
  }

  async function save(path: string): Promise<void> {
    if (!actions?.save) return
    setSaving(true)
    try {
      const results = await actions.save({ generations: [generation], path })
      setSaveOpen(false)
      onSaved?.(results)
    } finally {
      setSaving(false)
    }
  }

  const bars = isSpeech ? previewWaveformBars(generation.id, waveformBars) : []
  const hue = hashSeed(generation.id) % 360
  const secondHue = (hue + 34) % 360

  return (
    <figure
      role="button"
      tabIndex={0}
      aria-label={`${generation.prompt} — open`}
      className={classes}
      style={tileStyle}
      data-selectable={context === 'history'}
      data-selected={selected}
      onClick={activate}
      onKeyDown={onKeyDown}
    >
      <div className="absolute inset-0">
        {status === 'pending' || status === 'running' ? (
          <div className="studio-skeleton absolute inset-0" />
        ) : status === 'failed' ? (
          <div className="grid h-full w-full place-items-center bg-accent p-3 text-center text-[12px] text-destructive">
            {generationError(generation) ?? 'Generation failed'}
          </div>
        ) : generation.result === null ? (
          <div className="studio-skeleton absolute inset-0" />
        ) : generation.type === 'image' ? (
          <img
            src={generation.result}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            draggable={false}
          />
        ) : generation.type === 'video' || generation.type === 'avatar' ? (
          <video
            src={generation.result}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : generation.type === 'transcription' ? (
          <div className="grid h-full w-full place-items-center bg-muted text-muted-foreground">
            <FileText size={20} strokeWidth={1.5} />
          </div>
        ) : isSpeech ? (
          <div
            className="absolute inset-0"
            style={{ background: `linear-gradient(158deg, hsl(${hue} 38% 24%), hsl(${secondHue} 46% 13%))` }}
          >
            <div
              className="studio-wave-layers"
              ref={setWaveNode}
              style={{ color: `hsl(${hue} 92% 74%)` }}
            >
              <div className="studio-wave studio-wave-base">
                {bars.map((bar, index) => (
                  <i key={index} style={{ height: `${bar.heightPct}%`, opacity: bar.opacity }} />
                ))}
              </div>
              <div className="studio-wave studio-wave-play">
                {bars.map((bar, index) => (
                  <i key={index} style={{ height: `${bar.heightPct}%`, opacity: bar.opacity }} />
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="studio-tile-scrim absolute inset-0" />

      <div className="studio-tile-actions absolute right-2 top-2 flex gap-[5px]">
        <button
          type="button"
          className="studio-ibtn relative grid h-[30px] w-[30px] place-items-center rounded-full"
          data-tip="Download"
          aria-label="Download"
          onClick={(event) => {
            stop(event)
            void (actions?.download ?? downloadGenerationsViaAnchor)([generation])
          }}
        >
          <Download size={15} strokeWidth={1.5} />
        </button>

        {canSaveToVault && !savedToVault && actions?.save && (
          <div ref={containerRef}>
            <button
              {...triggerProps}
              type="button"
              className="studio-ibtn relative grid h-[30px] w-[30px] place-items-center rounded-full"
              data-tip="Save to vault"
              aria-label="Save to vault"
              onClick={(event) => {
                stop(event)
                setSaveOpen((open) => !open)
              }}
            >
              <FolderPlus size={15} strokeWidth={1.5} />
            </button>
            <VaultPathPopover
              open={saveOpen}
              triggerRef={triggerRef}
              panelRef={panelRef}
              generations={[generation]}
              onSubmit={save}
              onCancel={() => setSaveOpen(false)}
              pending={saving}
            />
          </div>
        )}

        {savedToVault && vaultPath && actions?.vaultHref && (
          <a
            href={actions.vaultHref(vaultPath)}
            className="studio-ibtn relative grid h-[30px] w-[30px] place-items-center rounded-full"
            data-tip="View in vault"
            aria-label="View in vault"
            onClick={(event) => {
              stop(event)
              if (actions.onOpenVault) {
                event.preventDefault()
                actions.onOpenVault(generation)
              }
            }}
          >
            <FolderOpen size={15} strokeWidth={1.5} />
          </a>
        )}
        {savedToVault && vaultPath && !actions?.vaultHref && actions?.onOpenVault && (
          <button
            type="button"
            className="studio-ibtn relative grid h-[30px] w-[30px] place-items-center rounded-full"
            data-tip="View in vault"
            aria-label="View in vault"
            onClick={(event) => {
              stop(event)
              actions.onOpenVault?.(generation)
            }}
          >
            <FolderOpen size={15} strokeWidth={1.5} />
          </button>
        )}

        {actions?.remove && onRequestDelete && (
          <button
            type="button"
            className="studio-ibtn studio-ibtn-danger relative grid h-[30px] w-[30px] place-items-center rounded-full"
            data-tip="Delete"
            aria-label="Delete"
            onClick={(event) => {
              stop(event)
              onRequestDelete(generation)
            }}
          >
            <Trash2 size={15} strokeWidth={1.5} />
          </button>
        )}
      </div>

      <div className="studio-tile-badges absolute bottom-2 left-2 flex items-center gap-1.5">
        {(generation.type === 'video' || generation.type === 'avatar') && (
          <span className="studio-chip-dark grid h-[22px] w-[22px] place-items-center rounded-full" aria-hidden="true">
            <Play size={11} strokeWidth={1.5} fill="currentColor" />
          </span>
        )}
        {isSpeech && (
          <button
            type="button"
            className="studio-play-btn studio-chip-dark grid h-[22px] w-[22px] place-items-center rounded-full"
            aria-label={isPlaying ? `Pause ${generation.prompt}` : `Play ${generation.prompt}`}
            onClick={(event) => {
              stop(event)
              playback.toggle(generation)
            }}
          >
            {isPlaying
              ? <Pause size={11} strokeWidth={1.5} fill="currentColor" />
              : <Play size={11} strokeWidth={1.5} fill="currentColor" />}
          </button>
        )}
        {savedToVault && vaultPath && (
          <span className="studio-chip-dark inline-flex h-5 items-center gap-1 rounded-full pl-1.5 pr-2 text-[11px]">
            <FolderOpen size={12} strokeWidth={1.5} />
            In vault
          </span>
        )}
      </div>

      {context === 'history' && (
        <button
          type="button"
          className={`studio-tile-sel studio-chip-dark absolute left-2 top-2 h-6 w-6 place-items-center rounded-full ${selected ? '!bg-primary border-primary' : ''}`}
          aria-pressed={selected}
          aria-label="Select this item"
          onClick={(event) => {
            stop(event)
            onToggleSelect?.(generation.id)
          }}
        >
          <Check
            size={13}
            strokeWidth={1.5}
            className={selected ? 'opacity-100' : 'opacity-0'}
          />
        </button>
      )}

      <figcaption className="studio-tile-prompt absolute inset-x-[11px] bottom-[9px] m-0 truncate text-[12px] text-white">
        {generation.prompt}
      </figcaption>
    </figure>
  )
}
