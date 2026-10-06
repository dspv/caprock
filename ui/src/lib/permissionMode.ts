import { useEffect, useState } from 'react'
import { api } from './api'
import { useApi } from './useApi'

/**
 * Permission modes in words, for the places that say which one a session is
 * about to run in ("continue · bypass permissions"). Keyed by Claude Code's
 * own names, which is the vocabulary every spawn request uses.
 */
const WORDS: Record<string, string> = {
  acceptEdits: 'accept edits',
  auto: 'auto mode',
  bypassPermissions: 'bypass permissions',
  dontAsk: "don't ask",
  manual: 'asks first',
  plan: 'plan mode',
}

/** The mode in a few words, or '' for none (the agent's own default). An
 *  unknown word is shown as it is rather than hidden. */
export function modeWords(mode: string | undefined): string {
  if (!mode) return ''
  return WORDS[mode] ?? mode
}

/**
 * The stated preference for new sessions (Settings → New sessions), or ''
 * when none is set; undefined until the daemon has answered. A device that
 * cannot read settings gets '' rather than waiting forever.
 */
export function useSpawnModePreference(): string | undefined {
  const settings = useApi(() => api.settings(), [], { live: false })
  if (settings.data) return settings.data.spawn_permission_mode ?? ''
  if (settings.error) return ''
  return undefined
}

/**
 * The mode a new-session dialog starts on: `fallback` until the preference
 * arrives, then the preference if one is set — unless the viewer has already
 * picked one, which is never overwritten under them.
 */
export function useInitialMode(fallback: string): [string, (m: string) => void] {
  const pref = useSpawnModePreference()
  const [mode, setMode] = useState(fallback)
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!touched && pref) setMode(pref)
  }, [pref, touched])
  const choose = (m: string) => {
    setTouched(true)
    setMode(m)
  }
  return [mode, choose]
}
