/**
 * The composer (.ai/21-app.md § Composer): an optional box under an agent's
 * terminal to write a message in, sent through the chat's queue
 * (`POST /v1/agents/{id}/queue`, ADR-053) exactly as the chat field sends it.
 *
 * Off by default, and when off nothing about a pane changes. The switch is
 * per viewer, in localStorage, like the terminal's appearance (termprefs),
 * and every pane follows it at once. Only a session Caprock started, live,
 * that is not a shell gets one (rule 7: Caprock never types into a process it
 * did not start).
 */
import { useEffect, useState } from 'react'
import type { SessionSummary } from './api'
import { typeable } from './prforce'

const KEY = 'caprock.app.composer'
const HISTORY_PREFIX = 'caprock.composer.history.'

/** What the composer remembers per session, newest last. */
export const HISTORY_MAX = 50

let current: boolean | null = null
const listeners = new Set<(on: boolean) => void>()

export function composerEnabled(): boolean {
  if (current === null) {
    try {
      current = localStorage.getItem(KEY) === '1'
    } catch {
      current = false
    }
  }
  return current
}

export function setComposerEnabled(on: boolean): void {
  current = on
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch { /* kept for this page only */ }
  for (const f of listeners) f(on)
}

export function subscribeComposer(f: (on: boolean) => void): () => void {
  listeners.add(f)
  return () => { listeners.delete(f) }
}

if (typeof window !== 'undefined') {
  // Another window of the app switched it.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    current = null
    const on = composerEnabled()
    for (const f of listeners) f(on)
  })
}

export function useComposerEnabled(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(composerEnabled)
  useEffect(() => subscribeComposer(setOn), [])
  return [on, setComposerEnabled]
}

/** Whether a pane showing this session gets a composer when it is switched on. */
export function composerFits(s: SessionSummary | undefined): boolean {
  return !!s && typeable(s)
}

/** The messages sent from the composer to a session, oldest first. */
export function loadHistory(sessionId: string): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(HISTORY_PREFIX + sessionId) ?? '[]')
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string').slice(-HISTORY_MAX) : []
  } catch {
    return []
  }
}

/** Adds a sent message; a repeat of the newest is not kept twice. */
export function pushHistory(sessionId: string, text: string): string[] {
  const list = loadHistory(sessionId)
  if (list[list.length - 1] !== text) list.push(text)
  const next = list.slice(-HISTORY_MAX)
  try { localStorage.setItem(HISTORY_PREFIX + sessionId, JSON.stringify(next)) } catch { /* kept until the page goes */ }
  return next
}

/**
 * The history step for ↑ (-1) or ↓ (+1). `at` is the entry shown, or
 * `list.length` for the empty field; the result is the new index and its
 * text ('' past the newest). Null when the key is not the history's.
 */
export function historyStep(list: readonly string[], at: number, dir: -1 | 1): { at: number; text: string } | null {
  const next = at + dir
  if (next < 0 || next > list.length) return null
  return { at: next, text: next === list.length ? '' : list[next]! }
}
