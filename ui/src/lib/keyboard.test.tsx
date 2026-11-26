import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

const kb = vi.hoisted(() => ({ hide: vi.fn(async () => {}), bar: vi.fn(async (_o: { isVisible: boolean }) => {}) }))
vi.mock('@capacitor/keyboard', () => ({ Keyboard: { hide: kb.hide, setAccessoryBarVisible: kb.bar } }))

import { hideKeyboard, isTypingField } from './keyboard'
import { showAccessoryBar } from '@/native/keyboard'
import { useFillViewport } from './phone'

function native(on: boolean) {
  const w = window as unknown as { Capacitor?: unknown }
  if (on) w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }
  else delete w.Capacitor
}

describe('hideKeyboard', () => {
  afterEach(() => {
    native(false)
    kb.hide.mockClear()
    document.body.innerHTML = ''
  })

  it('on a web page, the field loses the focus and no plugin is asked', async () => {
    const f = document.body.appendChild(document.createElement('textarea'))
    f.focus()
    hideKeyboard()
    expect(document.activeElement).not.toBe(f)
    await new Promise((r) => setTimeout(r, 0))
    expect(kb.hide).not.toHaveBeenCalled()
  })

  it('in the iOS app, Keyboard.hide() as well', async () => {
    native(true)
    const f = document.body.appendChild(document.createElement('input'))
    f.focus()
    hideKeyboard(f)
    await vi.waitFor(() => expect(kb.hide).toHaveBeenCalledTimes(1))
    expect(document.activeElement).not.toBe(f)
  })

  it('the app brings back the bar with Done', async () => {
    await showAccessoryBar()
    expect(kb.bar).toHaveBeenCalledWith({ isVisible: true })
  })

  it('a field is a typing field; a button or a read-only one is not', () => {
    expect(isTypingField(document.createElement('textarea'))).toBe(true)
    const ro = document.createElement('textarea')
    ro.readOnly = true
    expect(isTypingField(ro)).toBe(false)
    const b = document.createElement('input')
    b.type = 'checkbox'
    expect(isTypingField(b)).toBe(false)
    expect(isTypingField(document.createElement('button'))).toBe(false)
  })
})

function Fill({ gap = 0 }: { gap?: number }) {
  const ref = useFillViewport<HTMLDivElement>(true, gap)
  return <div ref={ref} data-fill />
}

describe('useFillViewport', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const viewport = (height: number, offsetTop: number) => {
    const vv = Object.assign(new EventTarget(), { height, offsetTop, width: 390, pageTop: offsetTop, pageLeft: 0, offsetLeft: 0, scale: 1 })
    vi.stubGlobal('visualViewport', vv)
    return vv
  }

  it('reaches the bottom of what is visible, the visual viewport\'s pan counted', () => {
    viewport(500, 0)
    const { container } = render(<Fill />)
    const el = container.querySelector('[data-fill]') as HTMLElement
    expect(el.style.height).toBe('500px')
    cleanup()
    // iOS Safari with the keyboard up: the visual viewport panned 120px down.
    viewport(400, 120)
    const again = render(<Fill />).container.querySelector('[data-fill]') as HTMLElement
    expect(again.style.height).toBe('520px')
  })
})
