import { describe, expect, it } from 'vitest'
import { HOLD_MS, releaseStops, VOICE_IDLE, voiceActive, voiceError, voiceErrorOpensSettings, voiceFieldText, voiceMessage, voiceReducer, type VoiceAction, type VoiceState } from './dictation'

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

describe('first use: macOS asks', () => {
  it('a dictation macOS asks about stays on, and listens once allowed', () => {
    let s = run([{ type: 'start', before: '', lang: 'en-US' }, { type: 'started', id: 1 }, { type: 'asking', id: 1 }])
    expect(s.asking).toBe(true)
    expect(voiceActive(s)).toBe(true)
    s = voiceReducer(s, { type: 'live', id: 1 })
    expect(s.asking).toBeUndefined()
    expect(s.phase).toBe('listening')
    s = voiceReducer(s, { type: 'partial', id: 1, text: 'hello' })
    expect(voiceFieldText(s)).toBe('hello')
  })

  it('stopped by the user while macOS asked, it ends quietly', () => {
    const s = run([{ type: 'start', before: 'x', lang: 'en-US' }, { type: 'started', id: 1 }, { type: 'asking', id: 1 }, { type: 'stop' }, { type: 'end', id: 1 }])
    expect(s.phase).toBe('idle')
    expect(s.error).toBeUndefined()
  })

  it('a refusal after asking still says so', () => {
    const s = run([{ type: 'start', before: '', lang: 'en-US' }, { type: 'started', id: 1 }, { type: 'asking', id: 1 }, { type: 'end', id: 1, error: 'mic-denied' }])
    expect(s.phase).toBe('error')
    expect(s.error).toBe('denied-mic')
  })
})

describe('long dictation', () => {
  it('words from a request the shell restarted come as more partial words; only the user ends it', () => {
    // The shell keeps what an ended request heard in front of the next one's.
    const s = run([
      { type: 'start', before: '', lang: 'en-US' },
      { type: 'started', id: 1 },
      { type: 'partial', id: 1, text: 'First part.' },
      { type: 'partial', id: 1, text: 'First part. Second' },
      { type: 'partial', id: 1, text: 'First part. Second part.' },
    ])
    expect(s.phase).toBe('partial')
    expect(voiceActive(s)).toBe(true)
    expect(voiceFieldText(s)).toBe('First part. Second part.')
  })
})

describe('hold to talk', () => {
  it('a release while macOS asks never stops it, however long the hold', () => {
    expect(releaseStops(1000, 9000, true, true)).toBe(false)
    // The next click still does.
    expect(releaseStops(1000, 1010, false, false)).toBe(true)
  })

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

describe('whisper on Windows and Linux (ADR-104)', () => {
  it('the shell’s codes for a missing, coming or unloadable model and an old processor are their own errors', () => {
    expect(voiceError('no-model')).toBe('no-model')
    expect(voiceError('downloading')).toBe('downloading')
    expect(voiceError('cpu-unsupported')).toBe('cpu')
    expect(voiceError('model-failed')).toBe('model-failed')
    for (const e of ['no-model', 'downloading', 'model-failed'] as const) expect(voiceErrorOpensSettings(e)).toBe(true)
    expect(voiceErrorOpensSettings('denied-mic')).toBe(false)
  })

  it('names the model, this OS’s settings and never macOS', () => {
    expect(voiceMessage('no-model', 'English', 'whisper')).toContain('Settings → Voice input')
    expect(voiceMessage('denied-mic', 'English', 'whisper', 'windows')).toBe(
      'Caprock may not use the microphone. Allow it in Settings → Privacy & security → Microphone, then try again.',
    )
    expect(voiceMessage('denied-mic', 'English', 'whisper', 'linux')).not.toContain('System Settings')
    expect(voiceMessage('unavailable-language', 'Klingon', 'whisper')).toContain("Klingon isn't a language the voice model knows")
    // The lines that are the same everywhere keep Apple's wording.
    expect(voiceMessage('no-audio', 'English', 'whisper')).toBe('Heard nothing — hold the mic and speak.')
    expect(voiceMessage('no-microphone', 'English', 'whisper')).toBe('No microphone found — connect one and try again.')
    // A Mac is untouched.
    expect(voiceMessage('denied-mic', 'English')).toContain('System Settings → Privacy & Security → Microphone')
  })
})
