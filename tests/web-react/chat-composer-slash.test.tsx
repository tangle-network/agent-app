// @vitest-environment jsdom
/**
 * The composer's `/` commands: typing `/` at position 0 opens the menu (a
 * PopoverSurface panel, portaled like every canonical popover), the rest of
 * the token filters it through the palette ranking, ArrowUp/ArrowDown +
 * Enter pick, Tab picks, Esc dismisses for the current token, and a space
 * ends it — arguments are ordinary text. A pick CLEARS the token and runs
 * the command; the menu never steals a send it has no match for.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ChatComposer, type SlashCommand } from '../../src/web-react/index'

afterEach(cleanup)

function makeCommands(): SlashCommand[] {
  return [
    { name: 'clear', description: 'Clear the conversation', run: vi.fn() },
    { name: 'model', description: 'Switch the model', run: vi.fn() },
    { name: 'rename', description: 'Rename this session', run: vi.fn() },
  ]
}

function renderComposer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const onSend = vi.fn()
  const slashCommands = makeCommands()
  const utils = render(createElement(ChatComposer, { onSend, slashCommands, focusShortcut: false, ...props }))
  const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement
  return { onSend, slashCommands, textarea, container: utils.container }
}

function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } })
}

describe('ChatComposer slash commands', () => {
  it('no slashCommands prop: "/" is ordinary text, no menu', () => {
    const onSend = vi.fn()
    render(createElement(ChatComposer, { onSend, focusShortcut: false }))
    const textarea = screen.getByLabelText('Message input')
    type(textarea as HTMLTextAreaElement, '/clear')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('typing "/" at position 0 opens the menu with every command', () => {
    const { textarea } = renderComposer()
    type(textarea, '/')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]?.textContent).toContain('/clear')
  })

  it('the token after "/" filters the menu through the palette ranking', () => {
    const { textarea } = renderComposer()
    type(textarea, '/re')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]?.textContent).toContain('/rename')
  })

  it('a "/" NOT at position 0 opens nothing', () => {
    const { textarea } = renderComposer()
    type(textarea, 'send /clear please')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('the first space ends the menu — arguments are ordinary text', () => {
    const { textarea } = renderComposer()
    type(textarea, '/model')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    type(textarea, '/model opus')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('ArrowDown + Enter picks the active command: clears the draft and runs it', () => {
    const { textarea, slashCommands } = renderComposer()
    type(textarea, '/')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(slashCommands[1]?.run).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Tab picks too', () => {
    const { textarea, slashCommands } = renderComposer()
    type(textarea, '/mod')
    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(slashCommands[1]?.run).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('')
  })

  it('a pick does NOT send a message', () => {
    const { textarea, onSend } = renderComposer()
    type(textarea, '/clear')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('Escape dismisses the menu but keeps the draft; further typing reopens it', () => {
    const { textarea } = renderComposer()
    type(textarea, '/re')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(textarea.value).toBe('/re')
    type(textarea, '/ren')
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('with the menu dismissed, Enter sends the raw token as text', () => {
    const { textarea, onSend, slashCommands } = renderComposer()
    type(textarea, '/re')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('/re')
    expect(slashCommands[2]?.run).not.toHaveBeenCalled()
  })

  it('a query with no match shows the empty state and Enter falls through to send', () => {
    const { textarea, onSend } = renderComposer()
    type(textarea, '/zzz')
    expect(screen.getByText('No matching commands')).toBeTruthy()
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('/zzz')
  })

  it('clicking a row runs it without blurring the textarea', () => {
    const { textarea, slashCommands } = renderComposer()
    type(textarea, '/')
    fireEvent.click(screen.getByText('/model'))
    expect(slashCommands[1]?.run).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('')
  })

  it('the panel is portaled out of the composer (host cannot clip it)', () => {
    const { textarea, container } = renderComposer()
    type(textarea, '/')
    const listbox = screen.getByRole('listbox')
    expect(container.contains(listbox)).toBe(false)
  })

  it('an outside mousedown dismisses the menu for the current token', () => {
    const { textarea } = renderComposer()
    type(textarea, '/')
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(textarea.value).toBe('/')
  })

  it('streaming and disabled states leave the menu behavior intact', () => {
    const { textarea, slashCommands } = renderComposer({ isStreaming: true, onCancel: vi.fn() })
    type(textarea, '/clear')
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(slashCommands[0]?.run).toHaveBeenCalledTimes(1)
  })
})
