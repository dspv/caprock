import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalInput } from './xtermInput'
import type { Terminal as Xterm } from '@xterm/xterm'

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

function fakeTerm(selection: string) {
  let handler: (e: KeyboardEvent) => boolean = () => true
  const host = document.createElement('div')
  const el = document.createElement('div')
  host.appendChild(el)
  document.body.appendChild(host)
  const term = {
    element: el,
    getSelection: () => selection,
    clearSelection: vi.fn(),
    attachCustomKeyEventHandler: (h: (e: KeyboardEvent) => boolean) => { handler = h },
    onData: () => ({ dispose() {} }),
    textarea: undefined,
  } as unknown as Xterm
  return { term, el, host, press: (init: KeyboardEventInit) => { const e = new KeyboardEvent('keydown', { cancelable: true, ...init }); return { ret: handler(e), e } } }
}

describe('copy from the terminal', () => {
  it('copies Cmd+C by the physical key on any layout, says so, and keeps the browser from beeping', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', clipboard: { writeText: vi.fn(() => Promise.resolve()) } })
    const t = fakeTerm('hello')
    attachTerminalInput(t.term, t.el, () => {})
    // A non-Latin layout reports another letter for the C key (Greek: ψ).
    const { ret, e } = t.press({ key: 'ψ', code: 'KeyC', metaKey: true })
    expect(ret).toBe(false)
    expect(e.defaultPrevented).toBe(true)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello')
    await Promise.resolve(); await Promise.resolve()
    expect(t.host.querySelector('[data-copied]')?.textContent).toBe('Copied · 5 chars')
  })

  it('lets Cmd+C through when nothing is selected', () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', clipboard: { writeText: vi.fn(() => Promise.resolve()) } })
    const t = fakeTerm('')
    attachTerminalInput(t.term, t.el, () => {})
    expect(t.press({ key: 'c', code: 'KeyC', metaKey: true }).ret).toBe(true)
  })
})
