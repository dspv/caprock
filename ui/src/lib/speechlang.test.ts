import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  baseLang, dedupeLangs, fullTag, langChip, langIntroDue, langName, markLangIntroSeen,
  myLangs, nextSpeechLang, setSpeechLang, speechLang,
} from './speechlang'

function browser(languages: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(languages[0] ?? '')
}

describe('speechlang', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('names tags', () => {
    expect(baseLang('ru-RU')).toBe('ru')
    expect(fullTag('ru')).toBe('ru-RU')
    expect(fullTag('en-GB')).toBe('en-GB')
    expect(fullTag('xx')).toBe('xx')
    expect(langChip('ru-RU')).toBe('RU')
    expect(langName('ja-JP')).toBe('Japanese')
    expect(langName('en-GB')).toBe('English')
  })

  it('keeps one tag per base language', () => {
    expect(dedupeLangs(['en-US', 'en', 'ru', 'ru-RU', 'de-AT'])).toEqual(['en-US', 'ru-RU', 'de-AT'])
  })

  it('listens for the browser language until one is chosen, then for the choice', () => {
    browser(['en-US'])
    expect(speechLang()).toBe('en-US')
    expect(myLangs()).toEqual(['en-US'])
    setSpeechLang('ru-RU')
    expect(speechLang()).toBe('ru-RU')
    // A language picked from the long list joins this viewer's languages.
    expect(myLangs()).toEqual(['en-US', 'ru-RU'])
  })

  it('a tap moves through the viewer languages, then opens the list', () => {
    expect(nextSpeechLang('en-US', ['en-US', 'ru-RU'])).toBe('ru-RU')
    expect(nextSpeechLang('ru-RU', ['en-US', 'ru-RU'])).toBe('more')
    expect(nextSpeechLang('en-US', ['en-US'])).toBe('more')
    expect(nextSpeechLang('ja-JP', ['en-US', 'ru-RU'])).toBe('en-US')
  })

  it('introduces the chip once, only to a browser with several languages', () => {
    browser(['en-US', 'en'])
    expect(langIntroDue()).toBe(false)
    browser(['en-US', 'ru'])
    expect(langIntroDue()).toBe(true)
    markLangIntroSeen()
    expect(langIntroDue()).toBe(false)
  })

  it('survives storage that throws', () => {
    browser(['de-DE'])
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(speechLang()).toBe('de-DE')
    expect(() => setSpeechLang('ru')).not.toThrow()
  })
})
