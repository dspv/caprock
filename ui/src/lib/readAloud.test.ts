import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoReadOn, plainForSpeech, READ_ALOUD_KEY, resetAutoRead, setAutoRead, speak, speechLangFor, stopSpeaking } from './readAloud'

// Cyrillic built from code points: rule 5 keeps the letters themselves out of the repo.
const cyr = (codes: number[]) => String.fromCharCode(...codes)

describe('read aloud: the switch', () => {
  beforeEach(() => { localStorage.clear(); resetAutoRead() })

  it('is on by default and remembers off per device', () => {
    expect(autoReadOn()).toBe(true)
    setAutoRead(false)
    expect(localStorage.getItem(READ_ALOUD_KEY)).toBe('off')
    expect(autoReadOn()).toBe(false)
    setAutoRead(true)
    expect(autoReadOn()).toBe(true)
  })

  it('reads as on when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(autoReadOn()).toBe(true)
    spy.mockRestore()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => setAutoRead(false)).not.toThrow()
    vi.restoreAllMocks()
  })
})

describe('read aloud: the text', () => {
  it('drops code blocks and markup, keeps the words', () => {
    const md = '# Done\n\nI changed `filepath.Join` in [the test](https://x.dev/a).\n\n```go\nfunc main() {}\n```\n\n- **one**\n- two'
    expect(plainForSpeech(md)).toBe('Done\nI changed filepath.Join in the test.\none\ntwo')
  })

  it('guesses Cyrillic or Latin, and leaves anything else to the browser', () => {
    expect(speechLangFor('All three jobs are green')).toBe('en-US')
    expect(speechLangFor(cyr([0x0412, 0x0441, 0x0451, 0x20, 0x0433, 0x043e, 0x0442, 0x043e, 0x0432, 0x043e]) + ' CI')).toBe('ru-RU')
    expect(speechLangFor('12345 !!')).toBe('')
  })
})

describe('read aloud: speaking', () => {
  afterEach(() => { vi.unstubAllGlobals(); stopSpeaking() })

  it('says false where the browser has no speech synthesis', () => {
    vi.stubGlobal('speechSynthesis', undefined)
    expect(speak('1', 'hello')).toBe(false)
  })

  it('speaks the plain text with a language, cancelling what was read before', () => {
    const spoken: { text: string; lang: string }[] = []
    const cancel = vi.fn()
    vi.stubGlobal('SpeechSynthesisUtterance', class { lang = ''; volume = 1; onend: null | (() => void) = null; onerror: null | (() => void) = null; constructor(public text: string) {} })
    vi.stubGlobal('speechSynthesis', { cancel, speak: (u: { text: string; lang: string }) => spoken.push({ text: u.text, lang: u.lang }) })
    expect(speak('7', 'The **fix** is on the branch.')).toBe(true)
    expect(cancel).toHaveBeenCalled()
    expect(spoken).toEqual([{ text: 'The fix is on the branch.', lang: 'en-US' }])
  })
})
