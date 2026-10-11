import { afterEach, describe, expect, it, vi } from 'vitest'
import { joinDictation, speechHint, speechSupport, startDictation } from './speech'

type Handler = ((e: unknown) => void) | null

class FakeRecognition {
  static last: FakeRecognition | null = null
  lang = ''
  continuous = false
  interimResults = false
  onresult: Handler = null
  onerror: Handler = null
  onend: (() => void) | null = null
  started = false
  constructor() { FakeRecognition.last = this }
  start() { this.started = true }
  stop() { this.onend?.() }
  abort() { this.onend?.() }
}

const result = (isFinal: boolean, transcript: string) => ({ isFinal, 0: { transcript } })
const w = window as { webkitSpeechRecognition?: unknown }

describe('speech', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete w.webkitSpeechRecognition
    FakeRecognition.last = null
  })

  it('needs the API and a secure page', () => {
    expect(speechSupport()).toBe('missing')
    w.webkitSpeechRecognition = FakeRecognition
    vi.stubGlobal('isSecureContext', false)
    expect(speechSupport()).toBe('insecure')
    expect(speechHint('insecure')).toMatch(/https/)
    expect(speechHint('insecure')).toMatch(/keyboard/)
    vi.stubGlobal('isSecureContext', true)
    expect(speechSupport()).toBe('ok')
  })

  it('joins what was typed and what was heard with one space', () => {
    expect(joinDictation('', 'hello')).toBe('hello')
    expect(joinDictation('Next:', ' hello')).toBe('Next: hello')
    expect(joinDictation('Next: ', 'hello')).toBe('Next: hello')
    expect(joinDictation('Next:', '')).toBe('Next:')
  })

  it('reports final and interim words, rebuilt from every result so none is said twice', () => {
    w.webkitSpeechRecognition = FakeRecognition
    const onText = vi.fn()
    const onEnd = vi.fn()
    const d = startDictation({ lang: 'en-GB', onText, onEnd })
    const r = FakeRecognition.last!
    expect(r.started && r.continuous && r.interimResults).toBe(true)
    expect(r.lang).toBe('en-GB')
    r.onresult?.({ results: [result(false, 'clean')] })
    expect(onText).toHaveBeenLastCalledWith('clean')
    r.onresult?.({ results: [result(true, 'clean up'), result(false, 'the')] })
    expect(onText).toHaveBeenLastCalledWith('clean up the')
    // Safari hands a final result back again in a later event.
    r.onresult?.({ results: [result(true, 'clean up'), result(true, ' the warning')] })
    expect(onText).toHaveBeenLastCalledWith('clean up the warning')
    d!.stop()
    expect(onEnd).toHaveBeenCalledWith(undefined)
  })

  it('passes an error code to onEnd, but not an abort', () => {
    w.webkitSpeechRecognition = FakeRecognition
    const onEnd = vi.fn()
    startDictation({ onText: () => {}, onEnd })
    FakeRecognition.last!.onerror?.({ error: 'not-allowed' })
    FakeRecognition.last!.onend?.()
    expect(onEnd).toHaveBeenCalledWith('not-allowed')
    const onEnd2 = vi.fn()
    startDictation({ onText: () => {}, onEnd: onEnd2 })
    FakeRecognition.last!.onerror?.({ error: 'aborted' })
    FakeRecognition.last!.onend?.()
    expect(onEnd2).toHaveBeenCalledWith(undefined)
  })
})
