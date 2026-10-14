import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { FACES, FACES_KEY, FACE_DEFAULT_KEY, MAX_PICKS, faceFor, hashedFace, hasOwnFace, saveFaceDefault, setSessionFace } from './faces'
import { FaceDefaultSetting, PickableFace, SessionCharacter } from '@/components/SessionFace'

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
