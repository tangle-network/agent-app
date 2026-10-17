/**
 * A searchable timezone field: the same popover, search and keyboard model as
 * `ModelPicker`. Zones come from the browser's IANA list, grouped by region
 * with today's UTC offset, and match by city, zone name or offset ("+5:30",
 * "utc-4"). The value is always the IANA name; one the list lacks still shows.
 */

import { Button, Input } from '@tangle-network/ui/primitives'
import { Check, ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { fieldPickerTriggerClass, OVERLAY_SHADOW, POPOVER_OPTION_FOCUS, PopoverSurface, usePopover } from '../web-react/controls'

export interface TimezonePickerProps {
  /** The trigger's id, for the row's label. */
  id?: string
  /** An IANA zone name, such as `America/New_York`. */
  value: string
  onChange: (zone: string) => void
  disabled?: boolean
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

interface Zone {
  id: string
  city: string
  region: string
  offsetMinutes: number
  offsetLabel: string
}

const REGIONS: Array<[prefix: string, label: string]> = [
  ['America', 'Americas'],
  ['Europe', 'Europe'],
  ['Africa', 'Africa'],
  ['Asia', 'Asia'],
  ['Australia', 'Australia'],
  ['Pacific', 'Pacific'],
  ['Atlantic', 'Atlantic'],
  ['Indian', 'Indian Ocean'],
  ['Antarctica', 'Antarctica'],
  ['Arctic', 'Arctic'],
]
const OTHER_REGION = 'UTC and other'

function regionOf(id: string): string {
  const prefix = id.split('/')[0] ?? ''
  return REGIONS.find(([name]) => name === prefix)?.[1] ?? OTHER_REGION
}

function cityOf(id: string): string {
  if (id === 'UTC' || id === 'Etc/UTC') return 'Coordinated Universal Time'
  return (id.split('/').pop() ?? id).replace(/_/g, ' ')
}

function offsetMinutesOf(id: string, now: Date): number | null {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'longOffset' })
      .formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? ''
    const match = /^GMT(?:([+-−])(\d{1,2})(?::(\d{2}))?)?$/.exec(part)
    if (!match) return null
    if (!match[1]) return 0
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0)
    return match[1] === '+' ? minutes : -minutes
  } catch {
    return null
  }
}

function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'UTC'
  const sign = minutes > 0 ? '+' : '−'
  const abs = Math.abs(minutes)
  const rest = abs % 60
  return `UTC${sign}${Math.floor(abs / 60)}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`
}

function zoneOf(id: string, now: Date): Zone | null {
  const offset = offsetMinutesOf(id, now)
  if (offset === null) return null
  return { id, city: cityOf(id), region: regionOf(id), offsetMinutes: offset, offsetLabel: offsetLabel(offset) }
}

function allZones(now: Date): Zone[] {
  const ids = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  const unique = ids.includes('UTC') ? ids : [...ids, 'UTC']
  return unique.map((id) => zoneOf(id, now)).filter((zone): zone is Zone => zone !== null)
}

/** "+5:30", "utc-4", "gmt +2" and "−03" read as an offset in minutes. */
function queryOffset(query: string): number | null {
  const match = /^(?:utc|gmt)?\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(query)
  if (!match) return /^(?:utc|gmt)$/.test(query) ? 0 : null
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0)
  return match[1] === '+' ? minutes : -minutes
}

function matches(zone: Zone, query: string): boolean {
  const offset = queryOffset(query)
  if (offset !== null) return zone.offsetMinutes === offset
  return zone.city.toLowerCase().includes(query)
    || zone.id.toLowerCase().replace(/_/g, ' ').includes(query)
    || zone.region.toLowerCase().includes(query)
}

function grouped(zones: Zone[]): Array<{ region: string; zones: Zone[] }> {
  const order = [...REGIONS.map(([, label]) => label), OTHER_REGION]
  return order
    .map((region) => ({
      region,
      zones: zones.filter((zone) => zone.region === region)
        .sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city)),
    }))
    .filter((group) => group.zones.length > 0)
}

export function TimezonePicker({ id, value, onChange, disabled = false, 'aria-describedby': describedBy, 'aria-invalid': invalid }: TimezonePickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const expanded = open && !disabled
  const changeOpen = useCallback((next: boolean) => {
    setOpen(next && !disabled)
    if (!next) setQuery('')
  }, [disabled])
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(expanded, changeOpen)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelId = useId()
  const searchId = useId()
  // Offsets are today's, so a zone in daylight time shows its current offset.
  const now = useMemo(() => new Date(), [expanded])
  const selected = useMemo(() => zoneOf(value, new Date()), [value])
  const zones = useMemo(() => (expanded ? allZones(now) : []), [expanded, now])
  const q = query.trim().toLowerCase()
  const groups = useMemo(() => grouped(q ? zones.filter((zone) => matches(zone, q)) : zones), [zones, q])

  useEffect(() => {
    if (!expanded) return
    const focus = () => inputRef.current?.focus()
    focus()
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
      const controls: HTMLElement[] = [input, ...panel.querySelectorAll<HTMLButtonElement>('button[data-zone]')]
      const index = controls.indexOf(document.activeElement as HTMLElement)
      if (index < 0) return
      if (event.key === 'Tab') {
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
      else if (event.key === 'Enter' && index === 0 && controls.length > 1) {
        event.preventDefault()
        ;(controls[1] as HTMLButtonElement).click()
        return
      } else return
      event.preventDefault()
      controls[next]?.focus()
    }
    panel.addEventListener('keydown', onKeyDown)
    return () => panel.removeEventListener('keydown', onKeyDown)
  })

  const pick = (zone: string) => {
    changeOpen(false)
    triggerRef.current?.focus()
    if (zone !== value) onChange(zone)
  }

  return (
    <div ref={containerRef} className="relative flex w-full min-w-0">
      <Button
        type="button"
        variant="bare"
        {...triggerProps}
        id={id}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-controls={expanded ? panelId : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        data-state={expanded ? 'open' : 'closed'}
        onClick={() => changeOpen(!expanded)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            changeOpen(true)
          }
        }}
        className={fieldPickerTriggerClass({ interactive: !disabled })}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate">{selected?.city ?? (value || 'Choose a timezone')}</span>
          {selected && <span className="shrink-0 text-muted-foreground tabular-nums">{selected.offsetLabel}</span>}
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Button>

      <PopoverSurface
        open={expanded}
        id={panelId}
        role="dialog"
        aria-label="Choose a timezone"
        triggerRef={triggerRef}
        panelRef={panelRef}
        matchTriggerWidth
        side="below"
        contentKey={q}
        className={`flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-card-edge bg-popover text-foreground ${OVERLAY_SHADOW}`}
      >
        <div className="shrink-0 border-b border-border p-2">
          <Input
            ref={inputRef}
            id={searchId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by city or UTC offset"
            aria-label="Search timezones"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="min-h-0 overflow-y-auto p-1 pb-2" data-zone-list>
          {groups.length === 0 && (
            <p role="status" className="px-3 py-4 text-center text-sm text-muted-foreground">No timezone matches “{query.trim()}”</p>
          )}
          {groups.map((group) => (
            <div key={group.region} role="group" aria-label={group.region}>
              <p className="px-3 pb-1 pt-3 text-sm font-semibold text-muted-foreground">{group.region}</p>
              {group.zones.map((zone) => {
                const current = zone.id === value
                return (
                  <Button
                    key={zone.id}
                    type="button"
                    variant="bare"
                    data-zone={zone.id}
                    aria-pressed={current}
                    title={zone.id}
                    onClick={() => pick(zone.id)}
                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm ${POPOVER_OPTION_FOCUS}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{zone.city}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">{zone.offsetLabel}</span>
                    <Check aria-hidden="true" className={`size-4 shrink-0 text-[var(--accent-text)] ${current ? '' : 'invisible'}`} />
                  </Button>
                )
              })}
            </div>
          ))}
        </div>
      </PopoverSurface>
    </div>
  )
}
