/**
 * Settings → Global shortcut, inside the desktop app: shows the shell's
 * hotkey, records a new one from a key press, and says why one was refused.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlobalHotkey } from './GlobalHotkey'
import type { HotkeyStatus } from '@/lib/shell'

const base: HotkeyStatus = { accelerator: 'control+alt+super+KeyC', default: 'control+alt+super+KeyC', registered: true, error: null, wayland: false }

let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  invoke = vi.fn(async (cmd: string, args?: { accelerator: string | null }) => {
    if (cmd === 'hotkey_status') return base
    if (cmd === 'register_hotkey') {
      if (args?.accelerator === 'Control+Alt+Super+KeyT') throw 'control+alt+super+KeyT is taken or refused by the system'
      return { ...base, accelerator: args?.accelerator ? args.accelerator.toLowerCase().replace('keyk', 'KeyK') : null }
    }
    throw new Error(cmd)
  })
  ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke }
})

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  vi.restoreAllMocks()
})

describe('GlobalHotkey', () => {
  it('shows the current shortcut in the platform’s symbols', async () => {
    render(<GlobalHotkey />)
    expect(await screen.findByTestId('hotkey-current')).toHaveTextContent('⌃⌥⌘C')
    expect(screen.queryByText(/^Use /)).toBeNull()
  })

  it('records a new shortcut from a key press and registers it', async () => {
    render(<GlobalHotkey />)
    fireEvent.click(await screen.findByText('Change'))
    const field = screen.getByText(/Press the new shortcut/)
    fireEvent.keyDown(field, { key: 'Meta', code: 'MetaLeft', metaKey: true })
    expect(invoke).not.toHaveBeenCalledWith('register_hotkey', expect.anything())
    fireEvent.keyDown(field, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, metaKey: true })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('register_hotkey', { accelerator: 'Control+Alt+Super+KeyK' }))
    expect(await screen.findByTestId('hotkey-current')).toHaveTextContent('⌃⌥⌘K')
    expect(screen.getByText('Use ⌃⌥⌘C')).toBeInTheDocument()
  })

  it('refuses a plain letter without asking the shell', async () => {
    render(<GlobalHotkey />)
    fireEvent.click(await screen.findByText('Change'))
    fireEvent.keyDown(screen.getByText(/Press the new shortcut/), { key: 'c', code: 'KeyC' })
    expect(screen.getByText(/Hold Control, Option or Command/)).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('register_hotkey', expect.anything())
  })

  it('says why the system refused a shortcut', async () => {
    render(<GlobalHotkey />)
    fireEvent.click(await screen.findByText('Change'))
    fireEvent.keyDown(screen.getByText(/Press the new shortcut/), { key: 't', code: 'KeyT', ctrlKey: true, altKey: true, metaKey: true })
    expect(await screen.findByText(/taken or refused by the system/)).toBeInTheDocument()
    expect(screen.getByTestId('hotkey-current')).toHaveTextContent('⌃⌥⌘C')
  })

  it('turns the hotkey off', async () => {
    render(<GlobalHotkey />)
    fireEvent.click(await screen.findByText('Turn off'))
    await waitFor(() => expect(screen.getByTestId('hotkey-current')).toHaveTextContent('Off'))
    expect(invoke).toHaveBeenCalledWith('register_hotkey', { accelerator: null })
  })
})
