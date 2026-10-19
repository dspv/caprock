import { afterEach, describe, expect, it, vi } from 'vitest'
import { assembleHeard, joinDictation, speechHint, speechSupport, startDictation } from './speech'

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
    const d = startDictation({ onText: () => {}, onEnd: onEnd2 })
    FakeRecognition.last!.onerror?.({ error: 'aborted' })
    d!.stop()
    expect(onEnd2).toHaveBeenCalledWith(undefined)
  })

  // Never lost (.ai/04-ui.md § Voice input): the paths a dictated message
  // used to vanish by, on Chrome for Android above all.
  it('listens again when the service ends by itself, keeping the words heard before', () => {
    w.webkitSpeechRecognition = FakeRecognition
    const onText = vi.fn()
    const onEnd = vi.fn()
    const d = startDictation({ lang: 'ru-RU', onText, onEnd })
    const first = FakeRecognition.last!
    // Interim only, then the end, no final: the words stay.
    first.onresult?.({ results: [result(false, 'καλημέρα')] })
    first.onend?.()
    expect(onEnd).not.toHaveBeenCalled()
    const second = FakeRecognition.last!
    expect(second).not.toBe(first)
    expect(second.started && second.lang === 'ru-RU').toBe(true)
    second.onresult?.({ results: [result(true, 'deploy it')] })
    expect(onText).toHaveBeenLastCalledWith('καλημέρα deploy it')
    // A late event from the old recognizer changes nothing.
    first.onresult?.({ results: [] })
    expect(onText).toHaveBeenLastCalledWith('καλημέρα deploy it')
    d!.stop()
    expect(onEnd).toHaveBeenCalledWith(undefined)
  })

  it('never lets a later, emptier event wipe the words shown', () => {
    w.webkitSpeechRecognition = FakeRecognition
    const onText = vi.fn()
    startDictation({ onText, onEnd: () => {} })
    const r = FakeRecognition.last!
    r.onresult?.({ results: [result(false, 'run the tests')] })
    r.onresult?.({ results: [] })
    r.onresult?.({ results: [result(true, '')] })
    expect(onText).toHaveBeenLastCalledWith('run the tests')
    expect(onText).toHaveBeenCalledTimes(1)
  })

  it('keeps what a result list held when the list starts over', () => {
    w.webkitSpeechRecognition = FakeRecognition
    const onText = vi.fn()
    startDictation({ onText, onEnd: () => {} })
    const r = FakeRecognition.last!
    r.onresult?.({ results: [result(true, 'café first')] })
    r.onresult?.({ results: [result(false, 'then')] })
    r.onresult?.({ results: [result(true, 'then this')] })
    expect(onText).toHaveBeenLastCalledWith('café first then this')
  })

  it('does not say twice a final that repeats the one before (Chrome on Android)', () => {
    expect(assembleHeard([result(true, 'turn'), result(true, 'turn on'), result(true, 'turn on the lights')] as never)).toBe('turn on the lights')
    expect(assembleHeard([result(true, 'go'), result(true, ' golang tests')] as never)).toBe('go golang tests')
    expect(assembleHeard([result(true, 'clean up'), result(false, 'the')] as never)).toBe('clean up the')
  })

  it('ends on a fatal error, or after three restarts that heard nothing', () => {
    w.webkitSpeechRecognition = FakeRecognition
    const onEnd = vi.fn()
    startDictation({ onText: () => {}, onEnd })
    FakeRecognition.last!.onerror?.({ error: 'network' })
    FakeRecognition.last!.onend?.()
    expect(onEnd).toHaveBeenCalledWith('network')
    const onEnd2 = vi.fn()
    startDictation({ onText: () => {}, onEnd: onEnd2 })
    for (let i = 0; i < 3; i++) {
      FakeRecognition.last!.onerror?.({ error: 'no-speech' })
      FakeRecognition.last!.onend?.()
    }
    expect(onEnd2).toHaveBeenCalledWith(undefined)
  })
})
