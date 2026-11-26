import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TerminalKeys } from './TerminalKeys'

function touch(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('pointer: coarse'), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList)
}

describe('TerminalKeys — the phone chat as a messenger', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('one row: +, the field as a pill, the mic while empty and Send once there are words', () => {
    touch(true)
    const send = vi.fn()
    const { container } = render(<TerminalKeys send={send} messenger voice foldKeys attach={async () => []} />)
    const field = screen.getByLabelText('Type to the session') as HTMLTextAreaElement
    expect(field.classList.contains('composer-pill')).toBe(true)
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    // No Keys, Attach or language chip on the row: they are under +.
    expect(screen.queryByRole('button', { name: /^Keys$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Attach a photo or file' })).toBeNull()
    expect(screen.queryByTestId('speech-lang')).toBeNull()
    fireEvent.change(field, { target: { value: 'hello' } })
    expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledWith('hello')
    expect(container.querySelector('[data-composer="messenger"]')).not.toBeNull()
  })

  it('+ holds Photos, Files, Keys and the dictation language', () => {
    touch(true)
    const send = vi.fn()
    render(<TerminalKeys send={send} messenger voice foldKeys attach={async () => []} />)
    fireEvent.click(screen.getByRole('button', { name: 'More: attach, keys, dictation language' }))
    const menu = screen.getByRole('menu', { name: 'More' })
    expect([...menu.querySelectorAll('[role=menuitem]')].map((b) => b.textContent)).toEqual([
      'PhotosPhoto library or camera', 'FilesPDF, text, office, code', 'KeysEsc, Tab, arrows, Enter, Ctrl+C', expect.stringMatching(/^ENDictation language/),
    ])
    // Keys: the six raw keys under the row, and the menu closes.
    fireEvent.click(screen.getByRole('menuitem', { name: /^Keys/ }))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Escape/ }))
    expect(send).toHaveBeenCalledWith('\x1b')
    // The language: its list in the same menu.
    fireEvent.click(screen.getByRole('button', { name: 'More: attach, keys, dictation language' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Dictation language/ }))
    const langs = screen.getByRole('menu', { name: 'Dictation language' })
    expect(langs.querySelectorAll('[role=menuitemradio]').length).toBeGreaterThan(3)
  })

  it('Photos opens the photo picker, inside the tap that chose it', () => {
    touch(true)
    render(<TerminalKeys send={vi.fn()} messenger voice foldKeys attach={async () => []} />)
    const photos = screen.getByTestId('photo-picker-photos') as HTMLInputElement
    const click = vi.spyOn(photos, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'More: attach, keys, dictation language' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Photos/ }))
    expect(click).toHaveBeenCalledTimes(1)
    expect(photos.accept).toBe('image/*')
  })

  it('the hide button sits in the row while typing', () => {
    touch(true)
    render(<TerminalKeys send={vi.fn()} messenger voice foldKeys />)
    const field = screen.getByLabelText('Type to the session')
    act(() => field.focus())
    fireEvent.click(screen.getByRole('button', { name: 'Hide the keyboard' }))
    expect(document.activeElement).not.toBe(field)
  })
})
