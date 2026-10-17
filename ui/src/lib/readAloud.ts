/**
 * Reading an agent's answer aloud on a phone (.ai/04-ui.md § From a phone,
 * *Read aloud*), by the browser's own speech synthesis
 * (`window.speechSynthesis`). Nothing is sent anywhere by Caprock: the
 * browser speaks with a voice it has.
 *
 * - **Feature-detected, never trusted.** Every call is wrapped: a browser
 *   without the API, or one that throws inside it, answers `false` and the
 *   caller says so in a line.
 * - **Plain text, not Markdown.** Code blocks are dropped (read aloud, a
 *   diff is noise), links read as their words, markup goes.
 * - **The language, roughly.** Mostly Cyrillic letters read as `ru-RU`,
 *   mostly Latin ones as `en-US`; anything else is left to the browser.
 * - **The auto read-aloud switch** (the speaker at the left of the phone's
 *   bar) is kept per device in `caprock.phone.readAloud`, on by default.
 */
import { useSyncExternalStore } from 'react'

/** Where the auto read-aloud switch is kept, per device. */
export const READ_ALOUD_KEY = 'caprock.phone.readAloud'

const listeners = new Set<() => void>()
function emit() {
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** Whether new answers are read aloud on this device: on unless turned off. */
export function autoReadOn(): boolean {
  try {
    return localStorage.getItem(READ_ALOUD_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Turns auto read-aloud on or off on this device. */
export function setAutoRead(on: boolean): void {
  try {
    localStorage.setItem(READ_ALOUD_KEY, on ? 'on' : 'off')
  } catch { /* storage refused: the switch holds for this page */ }
  memo = on
  if (!on) stopSpeaking()
  emit()
}

let memo: boolean | null = null
function autoSnapshot(): boolean {
  if (memo === null) memo = autoReadOn()
  return memo
}

/** The switch, kept in step across the bar and the chat. */
export function useAutoRead(): boolean {
  return useSyncExternalStore(subscribe, autoSnapshot)
}

/** For tests: forget the cached switch. */
export function resetAutoRead(): void {
  memo = null
  emit()
}

function synth(): SpeechSynthesis | null {
  try {
    if (typeof window === 'undefined') return null
    const s = window.speechSynthesis
    if (!s || typeof SpeechSynthesisUtterance === 'undefined') return null
    return s
  } catch {
    return null
  }
}

/** Whether this browser can read aloud at all. */
export function canSpeak(): boolean {
  return synth() !== null
}

/** What is being read now: the caller's key (an answer's id), or null. */
let speaking: string | null = null
function speakingSnapshot(): string | null {
  return speaking
}
function setSpeaking(k: string | null) {
  if (speaking === k) return
  speaking = k
  emit()
}

/** The key of what is being read now, or null. */
export function useSpeaking(): string | null {
  return useSyncExternalStore(subscribe, speakingSnapshot)
}

/** Stops whatever is being read. Safe to call at any time. */
export function stopSpeaking(): void {
  const s = synth()
  try { s?.cancel() } catch { /* nothing was speaking */ }
  setSpeaking(null)
}

/**
 * iOS speaks only from inside a user's gesture until it has once. Called on
 * the first tap in the bar, an empty utterance unlocks it for the auto
 * read-aloud that comes later without one.
 */
let primed = false
export function primeSpeech(): void {
  if (primed) return
  const s = synth()
  if (!s) return
  primed = true
  try {
    const u = new SpeechSynthesisUtterance('')
    u.volume = 0
    s.speak(u)
  } catch { /* not this browser */ }
}

/** Markdown turned into what a voice should say. */
export function plainForSpeech(md: string): string {
  let t = md.replace(/\r\n?/g, '\n')
  t = t.replace(/```[\s\S]*?(```|$)/g, ' ') // fenced code: not read
  t = t.replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
  t = t.replace(/<[^>\n]+>/g, ' ') // html tags
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images: their alt text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links: their words
  t = t.replace(/`([^`]*)`/g, '$1') // inline code: its text
  t = t.replace(/https?:\/\/\S+/g, 'link')
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
  t = t.replace(/^\s{0,3}>\s?/gm, '') // quotes
  t = t.replace(/^\s*([-*+]|\d+[.)])\s+/gm, '') // list markers
  t = t.replace(/^\s*\|?\s*:?-{3,}.*$/gm, '') // table separators
  t = t.replace(/\|/g, ', ')
  t = t.replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, '$2') // emphasis
  t = t.replace(/^\s*([-*_]\s*){3,}$/gm, '') // rules
  t = t.replace(/[ \t]+/g, ' ')
  t = t.replace(/\n{2,}/g, '\n').trim()
  return t
}

/** The utterance language for `text`, roughly: Cyrillic or Latin, else '' (the browser's own). */
export function speechLangFor(text: string): string {
  const cyr = (text.match(/[\u0400-\u04FF]/g) ?? []).length
  const lat = (text.match(/[A-Za-z]/g) ?? []).length
  if (cyr === 0 && lat === 0) return ''
  return cyr > lat ? 'ru-RU' : 'en-US'
}

/**
 * Reads `text` aloud under `key`, stopping anything read before. False when
 * this browser cannot; `onEnd` runs once it has finished or was stopped.
 */
export function speak(key: string, markdown: string, onEnd?: () => void): boolean {
  const s = synth()
  if (!s) return false
  const text = plainForSpeech(markdown)
  if (!text) return false
  try {
    s.cancel()
    const u = new SpeechSynthesisUtterance(text)
    const lang = speechLangFor(text)
    if (lang) u.lang = lang
    const done = () => {
      if (speaking === key) setSpeaking(null)
      onEnd?.()
    }
    u.onend = done
    u.onerror = done
    setSpeaking(key)
    s.speak(u)
    return true
  } catch {
    setSpeaking(null)
    return false
  }
}
