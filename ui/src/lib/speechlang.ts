/**
 * Which language dictation listens for (lib/speech).
 *
 * The Web Speech API cannot detect the language: it listens for the one it is
 * given, and Caprock gave it `navigator.language`, which on the owner's phone
 * is English while he speaks Russian (owner, 2026-10-14, translated: "speech
 * recognition is in English for some reason; I speak Russian — we need
 * multi-language"). So the composer carries a chip beside the microphone:
 * a tap moves through this viewer's languages (the browser's list, one per
 * base language, plus any picked from the longer list), then opens that list.
 * The choice is remembered per viewer and used for every dictation.
 */

/** Common dictation languages as BCP-47 tags, with English names. */
export const COMMON_SPEECH_LANGS: ReadonlyArray<readonly [tag: string, name: string]> = [
  ['en-US', 'English'],
  ['ru-RU', 'Russian'],
  ['uk-UA', 'Ukrainian'],
  ['de-DE', 'German'],
  ['fr-FR', 'French'],
  ['es-ES', 'Spanish'],
  ['pt-BR', 'Portuguese'],
  ['it-IT', 'Italian'],
  ['pl-PL', 'Polish'],
  ['tr-TR', 'Turkish'],
  ['ja-JP', 'Japanese'],
  ['zh-CN', 'Chinese'],
  ['ko-KR', 'Korean'],
  ['ar-SA', 'Arabic'],
  ['he-IL', 'Hebrew'],
]

const CHOICE_KEY = 'caprock.speech.lang'
const PICKED_KEY = 'caprock.speech.langs'
const SEEN_KEY = 'caprock.speech.langSeen'

/** The base language of a tag: `ru` of `ru-RU`, lower case. */
export function baseLang(tag: string): string {
  return (tag.split(/[-_]/)[0] ?? '').toLowerCase()
}

/** A tag with a region, for the speech service: `ru` becomes `ru-RU`. */
export function fullTag(tag: string): string {
  const t = tag.replace('_', '-')
  if (t.includes('-')) return t
  return COMMON_SPEECH_LANGS.find(([c]) => baseLang(c) === baseLang(t))?.[0] ?? t
}

/** What the chip says: the base language, upper case. */
export function langChip(tag: string): string {
  return baseLang(tag).toUpperCase()
}

/** The language's English name, or the tag when it is not a common one. */
export function langName(tag: string): string {
  const exact = COMMON_SPEECH_LANGS.find(([c]) => c.toLowerCase() === tag.toLowerCase())
  if (exact) return exact[1]
  return COMMON_SPEECH_LANGS.find(([c]) => baseLang(c) === baseLang(tag))?.[1] ?? tag
}

/** Tags in order, one per base language, the first spelling kept. */
export function dedupeLangs(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    if (!raw) continue
    const b = baseLang(raw)
    if (!b || seen.has(b)) continue
    seen.add(b)
    out.push(fullTag(raw))
  }
  return out
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch { /* remembered for this page only */ }
}

function browserLangs(): string[] {
  if (typeof navigator === 'undefined') return []
  const list = navigator.languages?.length ? navigator.languages : [navigator.language]
  return [...list].filter(Boolean)
}

/** The browser's languages, one per base language. */
export function browserSpeechLangs(): string[] {
  return dedupeLangs(browserLangs())
}

/** This viewer's languages: the browser's, then any picked from the long list. */
export function myLangs(): string[] {
  const picked = read(PICKED_KEY).split(',').filter(Boolean)
  const out = dedupeLangs([...browserLangs(), ...picked])
  return out.length ? out : ['en-US']
}

/** The language dictation listens for: the remembered choice, else the browser's first. */
export function speechLang(): string {
  return read(CHOICE_KEY) || (myLangs()[0] ?? 'en-US')
}

/** Remembers a choice, and keeps it among this viewer's languages. */
export function setSpeechLang(tag: string): void {
  const t = fullTag(tag)
  write(CHOICE_KEY, t)
  if (!browserSpeechLangs().some((b) => baseLang(b) === baseLang(t))) {
    const picked = read(PICKED_KEY).split(',').filter(Boolean)
    write(PICKED_KEY, dedupeLangs([...picked, t]).join(','))
  }
}

/**
 * What a tap on the chip does: the next of this viewer's languages, or —
 * past the last one, or with only one — the longer list.
 */
export function nextSpeechLang(current: string, mine: readonly string[]): string {
  const i = mine.findIndex((t) => baseLang(t) === baseLang(current))
  if (i < 0) return mine[0] ?? 'more'
  return i + 1 < mine.length ? (mine[i + 1] ?? 'more') : 'more'
}

/** Show the chip prominently once: the browser names more than one language. */
export function langIntroDue(): boolean {
  return browserSpeechLangs().length > 1 && !read(SEEN_KEY)
}

export function markLangIntroSeen(): void {
  write(SEEN_KEY, '1')
}
