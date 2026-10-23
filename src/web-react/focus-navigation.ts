/** Keep a modal's Tab navigation inside its current controls. No UI runtime dependency. */
export function containDialogTab(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>, panel: HTMLElement | null): void {
  if (event.key !== 'Tab') return
  const focusable = panel?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )
  if (!focusable || focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement as HTMLElement | null
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first?.focus()
  }
}

/** Native-button navigation shared by the model and time-zone search popovers. */
export function bindSearchPickerNavigation({ panel, input, trigger, onClose, buttonSelector, homeEnd = false, activateFirst = false }: {
  panel: HTMLElement
  input: () => HTMLInputElement | null
  trigger: () => HTMLElement | null
  onClose: () => void
  buttonSelector: string
  homeEnd?: boolean
  activateFirst?: boolean
}): () => void {
  function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    const search = input()
    if (!search) return
    const controls: HTMLElement[] = [search, ...panel.querySelectorAll<HTMLButtonElement>(buttonSelector)]
    const index = controls.indexOf(document.activeElement as HTMLElement)
    if (index < 0) return
    if (event.key === 'Tab') {
      // Portals are last in DOM order. Exit beside the trigger; forward Tab continues naturally.
      if ((event.shiftKey && index === 0) || (!event.shiftKey && index === controls.length - 1)) {
        onClose()
        trigger()?.focus()
        if (event.shiftKey) event.preventDefault()
      }
      return
    }
    let next: number
    if (event.key === 'ArrowDown') next = (index + 1) % controls.length
    else if (event.key === 'ArrowUp') next = (index - 1 + controls.length) % controls.length
    else if (homeEnd && event.key === 'Home' && index > 0) next = 1
    else if (homeEnd && event.key === 'End' && index > 0) next = controls.length - 1
    else if (activateFirst && event.key === 'Enter' && index === 0 && controls.length > 1) {
      event.preventDefault()
      ;(controls[1] as HTMLButtonElement).click()
      return
    } else return
    event.preventDefault()
    controls[next]?.focus()
  }
  panel.addEventListener('keydown', onKeyDown)
  return () => panel.removeEventListener('keydown', onKeyDown)
}
