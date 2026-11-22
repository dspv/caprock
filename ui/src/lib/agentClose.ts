/**
 * What closing the tab of an agent Caprock started does (owner, 2026-10-14).
 * A user wrote (translated): "chats don't disappear when I close them" — the
 * tab closed and its agent ran on, a muted row under "Running, no tab".
 * **ask** (the default, 2026-10-15): an idle agent ends with its tab, no
 * question, and a toast says the conversation is saved; one working or
 * waiting on you gets one sentence and two equal buttons, each with a line
 * saying what it does: *Keep it running* (focused: ⌘W then Enter; it works
 * on) and *Stop it* (2026-10-17). **keep** and **end**, set in
 * Settings → Closing a tab, never ask. *Always ask* (off by default), under
 * **ask**, puts the same question to an idle agent too, for a viewer who
 * would rather choose every time than have a tab end its agent unasked.
 * Kept per viewer, in this browser's storage. An agent another terminal
 * started is never asked about and never signalled (rule 7; lib/closeShell
 * planAgentClose).
 */
import { useEffect, useState } from 'react'

export type AgentClose = 'ask' | 'keep' | 'end'

export const AGENT_CLOSE_KEY = 'caprock.app.agent-close'
/** "on" when an idle agent's tab is asked about too; anything else is off. */
export const AGENT_CLOSE_ALWAYS_ASK_KEY = 'caprock.app.agent-close-always-ask'
const EVENT = 'caprock:agent-close'

export function loadAgentClose(): AgentClose {
  try {
    const v = localStorage.getItem(AGENT_CLOSE_KEY)
    return v === 'keep' || v === 'end' ? v : 'ask'
  } catch {
    return 'ask'
  }
}

export function saveAgentClose(v: AgentClose) {
  try { localStorage.setItem(AGENT_CLOSE_KEY, v) } catch { /* for this page only */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: v }))
}

/** Whether an idle agent's tab asks before closing, under **ask**. Off by default. */
export function loadAlwaysAsk(): boolean {
  try {
    return localStorage.getItem(AGENT_CLOSE_ALWAYS_ASK_KEY) === 'on'
  } catch {
    return false
  }
}

export function saveAlwaysAsk(on: boolean) {
  try {
    if (on) localStorage.setItem(AGENT_CLOSE_ALWAYS_ASK_KEY, 'on')
    else localStorage.removeItem(AGENT_CLOSE_ALWAYS_ASK_KEY)
  } catch { /* for this page only */ }
  window.dispatchEvent(new CustomEvent(EVENT))
}

/** A stored preference kept current across Settings, the close and other windows. */
function useStored<T>(load: () => T, save: (v: T) => void, key: string): [T, (v: T) => void] {
  const [v, setV] = useState<T>(load)
  useEffect(() => {
    const on = () => setV(load())
    const onStorage = (e: StorageEvent) => { if (e.key === key) on() }
    window.addEventListener(EVENT, on)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT, on)
      window.removeEventListener('storage', onStorage)
    }
  }, [load, key])
  return [v, (next: T) => { setV(next); save(next) }]
}

export function useAgentClose(): [AgentClose, (v: AgentClose) => void] {
  return useStored(loadAgentClose, saveAgentClose, AGENT_CLOSE_KEY)
}

export function useAlwaysAsk(): [boolean, (on: boolean) => void] {
  return useStored(loadAlwaysAsk, saveAlwaysAsk, AGENT_CLOSE_ALWAYS_ASK_KEY)
}
