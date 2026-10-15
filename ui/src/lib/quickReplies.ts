/**
 * Quick replies (.ai/04-ui.md § Quick replies): one-click answers to a
 * running session — Continue, Shorter, Explain, Run tests, Commit — drawn
 * under the terminal of a session Caprock started, and above the chat's
 * field (owner, 2026-10-15: "one-click quick replies to a running session").
 *
 * - **Sent the way the composer sends** (`POST /v1/agents/{id}/queue`,
 *   ADR-053): typed in at once when the agent is at its prompt, held and
 *   typed in when the turn ends otherwise; the daemon types a line break as
 *   ESC CR and submits with Enter after a pause.
 * - **Only into a session Caprock started** (rule 7): the row is drawn only
 *   where the composer could be (`composerFits`: owned, live, not a shell),
 *   and the daemon refuses any other session whatever the page draws.
 * - **The list is the daemon's** (`settings.quick_replies`, config.QuickReply):
 *   the defaults until changed in Settings → Terminal, the same in the app,
 *   a browser tab and a paired phone. Read once per page and shared here, so
 *   twenty panes do not ask twenty times; an edit in Settings reaches every
 *   pane at once.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { api, type QuickReply, type Settings } from './api'

export type { QuickReply }

let list: QuickReply[] | null = null
let asked = false
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

function load() {
  if (asked) return
  asked = true
  api.settings().then(
    (s) => { if (list === null) { list = s.quick_replies ?? []; emit() } },
    () => { asked = false },
  )
}

/** The list in use; empty until the daemon has answered. */
export function useQuickReplies(): QuickReply[] {
  useEffect(load, [])
  return useSyncExternalStore(subscribe, () => list ?? EMPTY)
}
const EMPTY: QuickReply[] = []

/** Replace the list everywhere and save it; the daemon's normalized answer is kept. */
export async function saveQuickReplies(next: QuickReply[]): Promise<void> {
  const before = list
  list = next
  emit()
  try {
    const saved = await api.saveSettings({ quick_replies: next } as Partial<Settings> as Settings)
    list = saved.quick_replies ?? next
    emit()
  } catch (e) {
    list = before
    emit()
    throw e
  }
}

/** Send one reply into a session Caprock started: the composer's path. */
export async function sendQuickReply(sessionId: string, text: string): Promise<void> {
  await api.queueSend(sessionId, text)
}

/** For tests: forget the list and ask again. */
export function resetQuickReplies(v: QuickReply[] | null = null) {
  list = v
  asked = v !== null
  emit()
}

/** The bounds the daemon checks (config.NormalizeQuickReplies), said by the form first. */
export const QUICK_MAX = 10
export const QUICK_LABEL_MAX = 24
export const QUICK_TEXT_MAX = 300
