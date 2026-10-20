/** Slash-command and skill selection for plain and rich composer inputs. */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { filterCommandPaletteItems, type CommandPaletteItem } from '../session-shell/index'
import type { ChatComposerProps } from './chat-composer-types'

type ComposerCommandsOptions = Pick<ChatComposerProps, 'mention' | 'slashCommands' | 'onSelectedSkillChange'> & {
  text: string
  textRef: RefObject<string>
  setText: (next: string) => void
  eligibleSkills: NonNullable<ChatComposerProps['eligibleSkills']>
}

export function useComposerCommands({ text, textRef, setText, mention, slashCommands, eligibleSkills, onSelectedSkillChange }: ComposerCommandsOptions) {
  // ── '/' commands ─────────────────────────────────────────────────────────
  // General commands exist only while the WHOLE draft is one leading slash
  // token (`/`, `/mod`); `/skill <query>` also searches eligible skills. Esc
  // or an outside click dismisses for the CURRENT token only, so continued
  // typing reopens the menu instead of leaving it permanently suppressed.
  const slashPanelRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const slashListId = useId()
  const [mentionSuggestionOpen, setMentionSuggestionOpen] = useState(false)
  const [slashActive, setSlashActive] = useState(0)
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null)
  // General commands retain their textarea-only contract. Eligible skills
  // deliberately share the menu in both input modes; the rich input forwards
  // its keyboard events below. `/skill <query>` filters only skills.
  const hasSkills = Boolean(onSelectedSkillChange && eligibleSkills.length > 0)
  const commandToken = !mention && slashCommands?.length ? /^\/(\S*)$/.exec(text)?.[1] : undefined
  const skillToken = hasSkills ? /^\/(\S*)$/.exec(text)?.[1] : undefined
  const skillInvocation = hasSkills ? /^\/skill(?:\s+(.*))?$/i.exec(text) : null
  const skillQuery = skillInvocation ? (skillInvocation[1] ?? '') : undefined
  const slashToken = skillQuery ?? skillToken ?? commandToken
  const slashOpen = slashToken !== undefined && text !== slashDismissedFor && !mentionSuggestionOpen
  const slashItems = useMemo<CommandPaletteItem[]>(
    () => [
      ...(!mention ? slashCommands ?? [] : []).map((command) => ({
        id: `command:${command.name}`,
        group: 'Commands',
        label: `/${command.name}`,
        description: command.description,
        keywords: [command.name, command.description],
      })),
      ...(onSelectedSkillChange ? eligibleSkills : []).map((skill) => ({
        id: `skill:${skill.id}`,
        group: 'Skills',
        label: `/skill ${skill.name}`,
        description: skill.description,
        keywords: [skill.id, skill.name, skill.description],
      })),
    ],
    [slashCommands, mention, eligibleSkills, onSelectedSkillChange],
  )
  const slashFiltered = useMemo(
    () => {
      if (slashToken === undefined) return []
      const items = skillQuery !== undefined ? slashItems.filter((item) => item.group === 'Skills') : slashItems
      return filterCommandPaletteItems(items, slashToken)
    },
    [slashItems, slashToken, skillQuery],
  )
  const slashActiveIndex = slashFiltered.length === 0 ? 0 : Math.min(slashActive, slashFiltered.length - 1)

  useEffect(() => {
    setSlashActive(0)
  }, [slashToken])

  useEffect(() => {
    if (!slashOpen) return
    document
      .getElementById(`${slashListId}-${slashActiveIndex}`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [slashOpen, slashActiveIndex, slashListId])

  useEffect(() => {
    if (!slashOpen) return
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (cardRef.current?.contains(target)) return
      if (slashPanelRef.current?.contains(target)) return
      setSlashDismissedFor(textRef.current)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [slashOpen])

  const pickSlash = useCallback(
    (id: string) => {
      // A pick consumes the current slash invocation: clear the box, then
      // report a typed skill or run the host's general command.
      setText('')
      setSlashDismissedFor(null)
      if (id.startsWith('skill:')) {
        const skill = eligibleSkills.find((item) => item.id === id.slice('skill:'.length))
        if (skill) onSelectedSkillChange?.(skill)
      } else if (id.startsWith('command:')) {
        slashCommands?.find((command) => command.name === id.slice('command:'.length))?.run()
      }
    },
    [slashCommands, eligibleSkills, onSelectedSkillChange, setText],
  )

  const handleSlashKeyDown = (e: Pick<globalThis.KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>): boolean => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (slashFiltered.length > 0) setSlashActive((slashActiveIndex + 1) % slashFiltered.length)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (slashFiltered.length > 0)
          setSlashActive((slashActiveIndex - 1 + slashFiltered.length) % slashFiltered.length)
        return true
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        const item = slashFiltered[slashActiveIndex]
        if (item) {
          e.preventDefault()
          pickSlash(item.id)
          return true
        }
        // No command matched — fall through and let Enter send the raw text.
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissedFor(text)
        return true
      }
    }
    return false
  }

  return { cardRef, slashPanelRef, slashListId, setMentionSuggestionOpen, slashActiveIndex, slashOpen, slashFiltered, skillQuery, hasSkills, setSlashActive, pickSlash, handleSlashKeyDown }
}
