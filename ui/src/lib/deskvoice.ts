/**
 * The desktop app's voice input: the shell listens and hands the words back
 * as `caprock:dictation` events. Nothing is recorded or sent anywhere.
 *
 * - **macOS** (ADR-102, app/src-tauri/src/dictate_macos.rs): Apple's speech
 *   recognition on this Mac; a language this Mac cannot recognise by itself
 *   is refused.
 * - **Windows and Linux** (ADR-104, dictate_whisper.rs): whisper.cpp in the
 *   app, from a voice model the user downloads in Settings → Voice input.
 *   Before that the status says `no-model` (or `downloading`), and the mic
 *   is still shown: a press says where to get the model.
 *
 * A browser tab and an app too old for it have no such command: the status
 * is null there and the button is hidden. The phone keeps its own voice
 * (lib/speech.ts).
 */
import { useEffect, useState } from 'react'
import { isTauri } from './appmode'
import { shell, type DictationStatus } from './shell'

/** The DOM event the shell dispatches (dictate.rs EVENT). */
export const DICTATION_EVENT = 'caprock:dictation'

/** One event from the shell: words so far, the final words, or the end. */
export type DictationEvent =
  | { kind: 'asking'; id: number }
  | { kind: 'listening'; id: number }
  | { kind: 'partial'; id: number; text: string }
  | { kind: 'final'; id: number; text: string }
  | { kind: 'end'; id: number; error?: string }

export type VoiceEngine = 'apple' | 'whisper'

let asked: Promise<DictationStatus | null> | null = null
const listeners = new Set<() => void>()

/** The shell's dictation status, asked once per page until refreshed; null where there is no shell or no such command. */
export function deskVoiceStatus(): Promise<DictationStatus | null> {
  if (!isTauri()) return Promise.resolve(null)
  asked ??= shell.dictationStatus().then((s) => (s && typeof s.supported === 'boolean' ? s : null), () => null)
  return asked
}

/** Whether this page can dictate through the shell now. */
export function deskVoiceAvailable(): Promise<boolean> {
  return deskVoiceStatus().then((s) => s?.supported === true)
}

/** Ask again and tell every microphone: the voice model came in or went. */
export function refreshDeskVoice(): void {
  asked = null
  for (const f of listeners) f()
}

/** For tests: forget the answer. */
export function resetDeskVoice(): void {
  asked = null
}

/** Who listens; a shell that predates the field is Apple's. */
export function voiceEngine(s: DictationStatus | null): VoiceEngine {
  return s?.engine === 'whisper' ? 'whisper' : 'apple'
}

/** The status reasons that still show the mic: it offers the voice model instead (Windows, Linux). */
const OFFERS_MODEL = new Set(['no-model', 'downloading'])

/** Whether the mic is shown: it can listen, or it can say where to get the voice model. */
export function micShown(s: DictationStatus | null): boolean {
  if (!s) return false
  return s.supported || (voiceEngine(s) === 'whisper' && OFFERS_MODEL.has(s.reason ?? ''))
}

/** `deskVoiceStatus` as state, followed through refreshes; null until the shell answered. */
export function useDeskVoiceStatus(on = true): DictationStatus | null {
  const [s, setS] = useState<DictationStatus | null>(null)
  useEffect(() => {
    if (!on) return
    let live = true
    const ask = () => { void deskVoiceStatus().then((v) => { if (live) setS(v) }) }
    ask()
    listeners.add(ask)
    return () => { live = false; listeners.delete(ask) }
  }, [on])
  return on ? s : null
}

/** `deskVoiceAvailable` as state: false until the shell said yes. */
export function useDeskVoiceAvailable(on = true): boolean {
  return useDeskVoiceStatus(on)?.supported === true
}

function isEvent(d: unknown): d is DictationEvent {
  if (!d || typeof d !== 'object') return false
  const e = d as Record<string, unknown>
  return typeof e.id === 'number' && (e.kind === 'asking' || e.kind === 'listening' || e.kind === 'partial' || e.kind === 'final' || e.kind === 'end')
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
