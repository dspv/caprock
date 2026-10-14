import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { DUCKS, DUCK_HINT_EVERY, FACES, FACES_KEY, FACE_DEFAULT_KEY, FACE_NAME, MAX_PICKS, duckHintDue, faceFor, hashedFace, hasOwnFace, isDuck, saveFaceDefault, setSessionFace } from './faces'
import { DUCK_HINT_LINGER, DUCK_HINT_QUIET, FaceDefaultSetting, PickableFace, SessionCharacter } from '@/components/SessionFace'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('faces', () => {
  it('gives a session the same face every time, and spreads sessions over all eight', () => {
    expect(hashedFace('8f1d2c3b-aaaa-bbbb')).toBe(hashedFace('8f1d2c3b-aaaa-bbbb'))
    expect(faceFor('8f1d2c3b-aaaa-bbbb')).toBe(hashedFace('8f1d2c3b-aaaa-bbbb'))
    const seen = new Set(Array.from({ length: 200 }, (_, i) => hashedFace(`session-${i}`)))
    expect([...seen].sort()).toEqual([...FACES].sort())
  })
  it('keeps a pick per session, and puts it back on the default', () => {
    const other = FACES.find((f) => f !== hashedFace('s1'))!
    setSessionFace('s1', other)
    expect(faceFor('s1')).toBe(other)
    expect(hasOwnFace('s1')).toBe(true)
    expect(JSON.parse(localStorage.getItem(FACES_KEY)!)).toEqual({ s1: other })
    setSessionFace('s1', null)
    expect(faceFor('s1')).toBe(hashedFace('s1'))
    expect(hasOwnFace('s1')).toBe(false)
  })
  it('a fixed default dresses every session without a pick of its own', () => {
    setSessionFace('mine', 'crown')
    saveFaceDefault('wizard')
    expect(localStorage.getItem(FACE_DEFAULT_KEY)).toBe('wizard')
    expect(faceFor('any')).toBe('wizard')
    expect(faceFor('mine')).toBe('crown')
    expect(faceFor(undefined)).toBe('wizard')
    saveFaceDefault('random')
    expect(faceFor(undefined)).toBe('cap')
  })
  it('keeps the newest picks only', () => {
    for (let i = 0; i < MAX_PICKS + 5; i++) setSessionFace(`s${i}`, 'tuft')
    const kept = Object.keys(JSON.parse(localStorage.getItem(FACES_KEY)!))
    expect(kept).toHaveLength(MAX_PICKS)
    expect(kept).not.toContain('s0')
    expect(kept).toContain(`s${MAX_PICKS + 4}`)
  })
  it('falls back to the hashed face when storage throws or holds garbage', () => {
    localStorage.setItem(FACES_KEY, '{not json')
    localStorage.setItem(FACE_DEFAULT_KEY, 'top hat')
    expect(faceFor('s2')).toBe(hashedFace('s2'))
    localStorage.setItem(FACES_KEY, JSON.stringify({ s2: 'top hat' }))
    expect(faceFor('s2')).toBe(hashedFace('s2'))
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(faceFor('s2')).toBe(hashedFace('s2'))
    expect(() => setSessionFace('s2', 'crown')).not.toThrow()
    expect(() => saveFaceDefault('crown')).not.toThrow()
  })
})

describe('the portrait', () => {
  it('draws Claude in its session face, another agent in its own mark', () => {
    const { container } = render(<><SessionCharacter agent="claude" sessionId="s3" /><SessionCharacter agent="codex" sessionId="s3" /></>)
    const svgs = container.querySelectorAll('svg')
    expect(svgs[0]!.getAttribute('data-face')).toBe(hashedFace('s3'))
    expect(svgs[1]!.hasAttribute('data-face')).toBe(false)
  })
  it('a click on the portrait picks a face that every portrait of the session follows', () => {
    const pick = FACES.find((f) => f !== hashedFace('s4'))!
    const { container } = render(
      <>
        <PickableFace agent="claude" sessionId="s4"><SessionCharacter agent="claude" sessionId="s4" /></PickableFace>
        <div data-elsewhere><SessionCharacter agent="claude" sessionId="s4" /></div>
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: "Change this session's face" }))
    const items = screen.getAllByRole('menuitemradio')
    expect(items).toHaveLength(8)
    expect(items.find((b) => b.getAttribute('aria-checked') === 'true')).toBeDefined()
    act(() => { fireEvent.click(items[FACES.indexOf(pick)]!) })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(container.querySelector('[data-elsewhere] svg')!.getAttribute('data-face')).toBe(pick)
    expect(faceFor('s4')).toBe(pick)
  })
  it('is not a button for an agent without faces', () => {
    render(<PickableFace agent="gemini" sessionId="s5"><SessionCharacter agent="gemini" sessionId="s5" /></PickableFace>)
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('Settings picks one face for every session, or a face per session', () => {
    render(<FaceDefaultSetting />)
    expect(screen.getByRole('radio', { name: 'A face per session' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Headphones' }))
    expect(screen.getByRole('radio', { name: 'Headphones' })).toHaveAttribute('aria-checked', 'true')
    expect(faceFor('whatever')).toBe('headphones')
  })
})

describe('rubber ducks', () => {
  // The hash as it was before the ducks: FNV-1a modulo the eight faces.
  const before = (id: string) => {
    let h = 0x811c9dc5
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) }
    return ['cap', 'beanie', 'headphones', 'crown', 'wizard', 'tuft', 'bandana', 'propeller'][(h >>> 0) % 8]
  }
  it('move nobody: every hashed session keeps the face it had', () => {
    expect(FACES).toEqual(['cap', 'beanie', 'headphones', 'crown', 'wizard', 'tuft', 'bandana', 'propeller'])
    for (let i = 0; i < 500; i++) {
      const id = `3f2a${i}-session-${i * 7}`
      expect(hashedFace(id)).toBe(before(id))
      expect(faceFor(id)).toBe(before(id))
    }
  })
  it('stay out of the random pool unless the default asks for them', () => {
    const plain = new Set(Array.from({ length: 300 }, (_, i) => faceFor(`s-${i}`)))
    expect([...plain].some(isDuck)).toBe(false)
    saveFaceDefault('random-ducks')
    const ducks = new Set(Array.from({ length: 300 }, (_, i) => faceFor(`s-${i}`)))
    expect([...ducks].sort()).toEqual([...DUCKS].sort())
    expect(faceFor(undefined)).toBe('duck')
    saveFaceDefault('random-all')
    const all = new Set(Array.from({ length: 600 }, (_, i) => faceFor(`s-${i}`)))
    expect(all.size).toBe(16)
    saveFaceDefault('duck-pirate')
    expect(faceFor('any')).toBe('duck-pirate')
  })
  it('a picked duck is kept like any face', () => {
    setSessionFace('d1', 'duck-sleepy')
    expect(faceFor('d1')).toBe('duck-sleepy')
    localStorage.setItem(FACES_KEY, JSON.stringify({ d1: 'duck-goose' }))
    expect(faceFor('d1')).toBe(hashedFace('d1'))
  })
  it('the picker has Faces and Ducks tabs, by click and by key', () => {
    render(<PickableFace agent="claude" sessionId="d2"><SessionCharacter agent="claude" sessionId="d2" /></PickableFace>)
    fireEvent.click(screen.getByRole('button', { name: "Change this session's face" }))
    expect(screen.getByRole('tab', { name: 'Faces' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('menuitemradio').map((b) => b.getAttribute('aria-label'))).toContain('Crown')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Faces' }), { code: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Ducks' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Ducks' })).toHaveFocus()
    const ducks = screen.getAllByRole('menuitemradio')
    expect(ducks.map((b) => b.getAttribute('aria-label'))).toEqual(DUCKS.map((d) => FACE_NAME[d]))
    act(() => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'Pirate duck' })) })
    expect(faceFor('d2')).toBe('duck-pirate')
    // It opens on the ducks for a session wearing one.
    fireEvent.click(screen.getByRole('button', { name: "Change this session's face" }))
    expect(screen.getByRole('tab', { name: 'Ducks' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('menuitemradio', { name: 'Pirate duck' })).toHaveFocus()
  })
  it('Settings offers the ducks, a duck per session, and both', () => {
    render(<FaceDefaultSetting />)
    fireEvent.click(screen.getByRole('radio', { name: 'A duck per session' }))
    expect(isDuck(faceFor('x'))).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Rainbow duck' }))
    expect(faceFor('x')).toBe('duck-rainbow')
    expect(screen.getByRole('radio', { name: 'Faces and ducks' })).toHaveAttribute('aria-checked', 'false')
  })
})

describe('the "try a duck?" line', () => {
  let clock = Date.UTC(2026, 9, 14, 9)
  beforeEach(() => { vi.useFakeTimers(); clock += 10 * DUCK_HINT_EVERY; vi.setSystemTime(clock) })
  afterEach(() => { vi.useRealTimers() })
  const portrait = (hint = true, id = 'h1') => (
    <PickableFace agent="claude" sessionId={id} hint={hint}><SessionCharacter agent="claude" sessionId={id} /></PickableFace>
  )
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
  const line = () => screen.queryByText(/try a duck\?/)

  it('shows after a quiet spell, and clicking it opens the ducks; then never again', () => {
    const { rerender } = render(portrait())
    wait(DUCK_HINT_QUIET - 2000)
    expect(line()).toBeNull()
    wait(3000)
    expect(line()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /try a duck/ }))
    expect(screen.getByRole('tab', { name: 'Ducks' })).toHaveAttribute('aria-selected', 'true')
    expect(duckHintDue(Date.now() + 100 * DUCK_HINT_EVERY)).toBe(false)
    fireEvent.keyDown(document, { code: 'Escape' })
    rerender(portrait(false)); rerender(portrait(true))
    wait(DUCK_HINT_EVERY)
    expect(line()).toBeNull()
  })
  it('never while a prompt is up or the agent works (hint off)', () => {
    render(portrait(false))
    wait(60_000)
    expect(line()).toBeNull()
  })
  it('never while the user types, and a key hides it', () => {
    render(portrait())
    for (let i = 0; i < 20; i++) { wait(1000); fireEvent.keyDown(document, { code: 'KeyA' }) }
    expect(line()).toBeNull()
    wait(DUCK_HINT_QUIET + 1000)
    expect(line()).not.toBeNull()
    fireEvent.keyDown(document, { code: 'KeyA' })
    expect(line()).toBeNull()
  })
  it('at most once a day; gone when ignored; gone for good after two closes', () => {
    const { unmount } = render(portrait())
    wait(DUCK_HINT_QUIET + 1000)
    expect(line()).not.toBeNull()
    wait(DUCK_HINT_LINGER)
    expect(line()).toBeNull()
    wait(60 * 60 * 1000)
    expect(line()).toBeNull()
    unmount()
    for (let n = 0; n < 2; n++) {
      clock += DUCK_HINT_EVERY + 1; vi.setSystemTime(clock)
      const r = render(portrait())
      wait(DUCK_HINT_QUIET + 1000)
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
      expect(line()).toBeNull()
      r.unmount()
    }
    clock += 5 * DUCK_HINT_EVERY; vi.setSystemTime(clock)
    render(portrait())
    wait(DUCK_HINT_QUIET + 1000)
    expect(line()).toBeNull()
  })
  it('not on a session already in a duck, nor when storage throws', () => {
    setSessionFace('h2', 'duck')
    const { unmount } = render(portrait(true, 'h2'))
    wait(DUCK_HINT_QUIET + 1000)
    expect(line()).toBeNull()
    unmount()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    render(portrait())
    wait(DUCK_HINT_QUIET + 1000)
    expect(line()).toBeNull()
  })
})
