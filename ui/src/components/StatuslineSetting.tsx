/**
 * Settings → Status line: what Caprock's line at the bottom of Claude Code
 * shows (internal/statusline). In the app the cockpit already shows cost,
 * turns and limits, so the full line repeats it and takes a terminal row.
 *
 * Full (the default): everything, as before. Short: model, context and the
 * plan windows — the reset time only once the five-hour window is at 80%.
 * Off: Caprock removes its own statusLine entry from Claude Code's settings
 * (never one you set yourself); choosing Full or Short puts it back. The
 * daemon keeps the choice, and the line reads it as it draws.
 */
import { useState } from 'react'
import { api, errText, type Settings, type StatuslineMode } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Choice, Section } from './SettingsParts'

const OPTIONS: { value: StatuslineMode; label: string }[] = [
  { value: 'full', label: 'Full' },
  { value: 'short', label: 'Short' },
  { value: 'off', label: 'Off' },
]

export const STATUSLINE_HINT: Record<StatuslineMode, string> = {
  full: 'Model, context, cost, turns, steps and your plan limits, under every Claude Code session.',
  short: 'Model, context and your plan limits; the reset time only once the 5-hour window is at 80%. Cost and counters stay in the cockpit.',
  off: 'Caprock’s line is removed from Claude Code. Its plan limits then stop reaching Caprock, so the cockpit and Cost show them only as last seen.',
}

export function StatuslineSetting() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const [picked, setPicked] = useState<StatuslineMode | null>(null)
  const [error, setError] = useState('')
  if (!settings.data) return null
  const value: StatuslineMode = picked ?? settings.data.statusline_mode ?? 'full'
  const save = async (mode: StatuslineMode) => {
    setError('')
    setPicked(mode)
    try {
      await api.saveSettings({ statusline_mode: mode } as Partial<Settings> as Settings)
    } catch (e) {
      setError(errText(e))
    }
  }
  return (
    <Section id="settings-statusline" title="Status line">
      <Choice label="In Claude Code" value={value} options={OPTIONS} onChange={(m) => void save(m)} />
      <p className="text-[12px] leading-relaxed text-fg-muted" data-statusline-hint>
        {STATUSLINE_HINT[value]} A status line you set yourself is never changed.
      </p>
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}
