import { describe, expect, it } from 'vitest'
import { HOLD_MS, releaseStops, VOICE_IDLE, voiceActive, voiceError, voiceFieldText, voiceMessage, voiceReducer, type VoiceAction, type VoiceState } from './dictation'

const run = (actions: VoiceAction[], from: VoiceState = VOICE_IDLE) => actions.reduce(voiceReducer, from)

describe('voice input state', () => {
  it('goes idle → starting → listening → partial → stopping → final → inserted', () => {
    let s = voiceReducer(VOICE_IDLE, { type: 'start', before: 'Fix', lang: 'en-US' })
    expect(s.phase).toBe('starting')
    expect(voiceFieldText(s)).toBe('Fix')
    s = voiceReducer(s, { type: 'started', id: 4 })
    expect(s.phase).toBe('listening')
    s = voiceReducer(s, { type: 'partial', id: 4, text: 'the' })
    expect(s.phase).toBe('partial')
    expect(voiceFieldText(s)).toBe('Fix the')
    s = voiceReducer(s, { type: 'partial', id: 4, text: 'the parser' })
    expect(voiceFieldText(s)).toBe('Fix the parser')
    s = voiceReducer(s, { type: 'stop' })
    expect(s.phase).toBe('stopping')
    s = voiceReducer(s, { type: 'final', id: 4, text: 'the parser, please.' })
    expect(s.phase).toBe('final')
    s = voiceReducer(s, { type: 'end', id: 4 })
    expect(s.phase).toBe('inserted')
    expect(s.error).toBeUndefined()
    expect(voiceFieldText(s)).toBe('Fix the parser, please.')
    expect(voiceActive(s)).toBe(false)
    // Typing again hands the field back.
    s = voiceReducer(s, { type: 'dismiss' })
    expect(s.phase).toBe('idle')
    expect(voiceFieldText(s)).toBeNull()
  })

  it('never wipes heard words with an empty guess or an empty final', () => {
    const s = run([
      { type: 'start', before: '', lang: 'ru-RU' },
      { type: 'started', id: 1 },
      { type: 'partial', id: 1, text: 'hello' },
      { type: 'partial', id: 1, text: '' },
      { type: 'final', id: 1, text: '  ' },
      { type: 'end', id: 1 },
    ])
    expect(s.phase).toBe('inserted')
    expect(voiceFieldText(s)).toBe('hello')
  })

  it('ignores another dictation’s events', () => {
    const s = run([
      { type: 'start', before: '', lang: 'en-US' },
      { type: 'started', id: 2 },
      { type: 'partial', id: 1, text: 'stale' },
      { type: 'end', id: 1, error: 'failed' },
    ])
    expect(s.phase).toBe('listening')
    expect(s.heard).toBe('')
  })

  it('a release before the shell answered stops once the id comes', () => {
    const s = run([
      { type: 'start', before: '', lang: 'en-US' },
      { type: 'stop' },
      { type: 'started', id: 9 },
    ])
    expect(s.phase).toBe('stopping')
    expect(s.id).toBe(9)
    expect(run([{ type: 'end', id: 9 }], s).phase).toBe('error')
  })

  it('a refused microphone says so, and so does refused speech recognition', () => {
    const mic = run([{ type: 'start', before: 'x', lang: 'en-US' }, { type: 'started', id: 1 }, { type: 'end', id: 1, error: 'mic-denied' }])
    expect(mic.phase).toBe('error')
    expect(mic.error).toBe('denied-mic')
    // The field is the user's again, as typed.
    expect(voiceFieldText(mic)).toBeNull()
    const speech = run([{ type: 'start', before: '', lang: 'en-US' }, { type: 'started', id: 1 }, { type: 'end', id: 1, error: 'speech-denied' }])
    expect(speech.error).toBe('denied-speech')
    expect(voiceMessage('denied-mic', 'English')).toContain('Privacy & Security → Microphone')
    expect(voiceMessage('denied-speech', 'English')).toContain('Speech Recognition')
  })

  it('a language this Mac cannot recognise by itself is refused, and the line says audio would go to Apple', () => {
    for (const code of ['on-device-unavailable', 'language-unsupported', 'unavailable']) {
      const s = run([{ type: 'start', before: '', lang: 'uk-UA' }, { type: 'started', id: 3 }, { type: 'end', id: 3, error: code }])
      expect(s.phase, code).toBe('error')
      expect(s.error, code).toBe('unavailable-language')
    }
    expect(voiceMessage('unavailable-language', 'Ukrainian')).toBe(
      "Ukrainian isn't available on this Mac without sending audio to Apple, so nothing was recorded. Pick another language, or add Ukrainian under System Settings → Keyboard → Dictation.",
    )
  })

  it('nothing heard is its own error; silence after words is not', () => {
    const none = run([{ type: 'start', before: '', lang: 'en-US' }, { type: 'started', id: 1 }, { type: 'stop' }, { type: 'end', id: 1, error: 'no-speech' }])
    expect(none.phase).toBe('error')
    expect(none.error).toBe('no-audio')
    const plain = run([{ type: 'start', before: '', lang: 'en-US' }, { type: 'started', id: 1 }, { type: 'end', id: 1 }])
    expect(plain.error).toBe('no-audio')
    const after = run([{ type: 'start', before: '', lang: 'en-US' }, { type: 'started', id: 1 }, { type: 'partial', id: 1, text: 'ok' }, { type: 'end', id: 1, error: 'no-speech' }])
    expect(after.phase).toBe('inserted')
    expect(after.error).toBeUndefined()
    const mic = run([{ type: 'start', before: '', lang: 'en-US' }, { type: 'started', id: 1 }, { type: 'end', id: 1, error: 'no-microphone' }])
    expect(mic.error).toBe('no-microphone')
  })

  it('a failure after words keeps the words and says what happened', () => {
    const s = run([{ type: 'start', before: '', lang: 'en-US' }, { type: 'started', id: 1 }, { type: 'partial', id: 1, text: 'half a' }, { type: 'end', id: 1, error: 'boom' }])
    expect(s.phase).toBe('inserted')
    expect(s.error).toBe('failed')
    expect(voiceFieldText(s)).toBe('half a')
  })

  it('a shell without the command refuses at start', () => {
    const s = run([{ type: 'start', before: '', lang: 'en-US' }, { type: 'refused', error: 'unsupported' }])
    expect(s.phase).toBe('error')
    expect(s.error).toBe('unsupported')
  })

  it('a second start while listening is ignored; cancel ends it at once', () => {
    let s = run([{ type: 'start', before: 'a', lang: 'en-US' }, { type: 'started', id: 1 }, { type: 'partial', id: 1, text: 'b' }])
    expect(voiceReducer(s, { type: 'start', before: 'zzz', lang: 'de-DE' })).toBe(s)
    s = voiceReducer(s, { type: 'cancel' })
    expect(s.phase).toBe('idle')
    expect(s.lang).toBe('en-US')
    // Late words from the cancelled one change nothing.
    expect(voiceReducer(s, { type: 'partial', id: 1, text: 'late' })).toBe(s)
  })

  it('maps the shell’s codes, superseded and an empty one being no fault', () => {
    expect(voiceError(undefined)).toBeNull()
    expect(voiceError('superseded')).toBeNull()
    expect(voiceError('unbundled')).toBe('unsupported')
    expect(voiceError('whatever')).toBe('failed')
  })
})

describe('hold to talk', () => {
  it('a long press that started it stops on release', () => {
    expect(releaseStops(1000, 1000 + HOLD_MS, true)).toBe(true)
  })
  it('a click that started it leaves it listening', () => {
    expect(releaseStops(1000, 1100, true)).toBe(false)
  })
  it('a press while it listens stops it, however short', () => {
    expect(releaseStops(1000, 1010, false)).toBe(true)
  })
})
