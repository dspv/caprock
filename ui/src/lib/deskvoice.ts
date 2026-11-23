/**
 * The desktop app's voice input (ADR-102): the shell listens with Apple's
 * speech recognition on this Mac (app/src-tauri/src/dictate_macos.rs) and
 * hands the words back as `caprock:dictation` events. Nothing is recorded or
 * sent anywhere; a language this Mac cannot recognise by itself is refused.
 *
 * Windows, Linux, a browser tab and an app too old for it have no such
 * command: `deskVoiceAvailable` says false there and the button is hidden.
 * The phone keeps its own voice (lib/speech.ts).
 */
import { useEffect, useState } from 'react'
import { isTauri } from './appmode'
import { shell } from './shell'

/** The DOM event the shell dispatches (dictate.rs EVENT). */
export const DICTATION_EVENT = 'caprock:dictation'

/** One event from the shell: words so far, the final words, or the end. */
export type DictationEvent =
  | { kind: 'partial'; id: number; text: string }
  | { kind: 'final'; id: number; text: string }
  | { kind: 'end'; id: number; error?: string }

let asked: Promise<boolean> | null = null

/** Whether this page can dictate through the shell; asked once per page. */
export function deskVoiceAvailable(): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false)
  asked ??= shell.dictationStatus().then((s) => s?.supported === true, () => false)
  return asked
}

/** For tests: forget the answer. */
export function resetDeskVoice(): void {
  asked = null
}

/** `deskVoiceAvailable` as state: false until the shell said yes. */
export function useDeskVoiceAvailable(on = true): boolean {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    if (!on) return
    let live = true
    void deskVoiceAvailable().then((v) => { if (live) setOk(v) })
    return () => { live = false }
  }, [on])
  return on && ok
}

function isEvent(d: unknown): d is DictationEvent {
  if (!d || typeof d !== 'object') return false
  const e = d as Record<string, unknown>
  return typeof e.id === 'number' && (e.kind === 'partial' || e.kind === 'final' || e.kind === 'end')
}

/** Calls `fn` with each dictation event; returns the unsubscribe. */
export function onDictation(fn: (e: DictationEvent) => void): () => void {
  const h = (ev: Event) => {
    const d = (ev as CustomEvent).detail
    if (isEvent(d)) fn(d)
  }
  window.addEventListener(DICTATION_EVENT, h)
  return () => window.removeEventListener(DICTATION_EVENT, h)
}

export const deskVoice = {
  start: (lang: string) => shell.dictationStart(lang),
  stop: (id: number, cancel = false) => shell.dictationStop(id, cancel).catch(() => {}),
}
