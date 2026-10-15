/**
 * What closing the tab of an agent Caprock started does (owner, 2026-10-14).
 * A user wrote (translated): "chats don't disappear when I close them" — the
 * tab closed and its agent ran on, a muted row under "Running, no tab".
 * **ask** (the default, 2026-10-15): an idle agent ends with its tab, no
 * question, and a toast says the conversation is saved; one working or
 * waiting on you gets one sentence, *Close tab* (focused: ⌘W then Enter; it
 * works on) and a quiet *Stop it instead*. **keep** and **end**, set in
 * Settings → Closing a tab, never ask. Kept per viewer, in this browser's storage. An
 * agent another terminal started is never asked about and never signalled
 * (rule 7; lib/closeShell planAgentClose).
 */
import { useEffect, useState } from 'react'

export type AgentClose = 'ask' | 'keep' | 'end'

export const AGENT_CLOSE_KEY = 'caprock.app.agent-close'
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

export function useAgentClose(): [AgentClose, (v: AgentClose) => void] {
  const [v, setV] = useState<AgentClose>(loadAgentClose)
  useEffect(() => {
    const on = () => setV(loadAgentClose())
    const onStorage = (e: StorageEvent) => { if (e.key === AGENT_CLOSE_KEY) on() }
    window.addEventListener(EVENT, on)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT, on)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return [v, (next: AgentClose) => { setV(next); saveAgentClose(next) }]
}
