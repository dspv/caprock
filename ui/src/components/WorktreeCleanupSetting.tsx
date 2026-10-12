/**
 * Settings → Worktrees: what happens to finished copies — Caprock's
 * worktrees that are merged, pushed, clean and have nothing running in them
 * (internal/projects/cleanup.go; the line is components/CleanupLine).
 *
 * Off: nothing is said or done. Ask (the default): the project's page and
 * the deck's Branches view say "3 copies done · Clean up". Auto: they are
 * removed a day after they finish, and the line offers Undo for a day. Either
 * way the branch is kept 7 days, so a copy can be restored.
 */
import { useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import type { CleanupMode } from '@/lib/copies'
import { useApi } from '@/lib/useApi'
import { Choice, Section } from './SettingsParts'

const OPTIONS: { value: CleanupMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'ask', label: 'Ask' },
  { value: 'auto', label: 'Auto' },
]

export const CLEANUP_HINT: Record<CleanupMode, string> = {
  off: 'Finished copies stay until you remove them (Clean up copies… in a project’s menu).',
  ask: 'When a copy Caprock made is merged, pushed, clean and nothing runs in it, the project’s page says so with one click to clean up. Nothing is removed until you click.',
  auto: 'A finished copy is removed a day after it finished, and the project’s page offers Undo for a day.',
}

export function WorktreeCleanupSetting() {
  const settings = useApi(() => api.settings(), [], { live: false })
  const [picked, setPicked] = useState<CleanupMode | null>(null)
  const [error, setError] = useState('')
  if (!settings.data) return null
  const value: CleanupMode = picked ?? settings.data.worktree_cleanup ?? 'ask'
  const save = async (mode: CleanupMode) => {
    setError('')
    setPicked(mode)
    try {
      await api.saveSettings({ worktree_cleanup: mode } as Partial<Settings> as Settings)
    } catch (e) {
      setError(errText(e))
    }
  }
  return (
    <Section id="settings-worktrees" title="Worktrees">
      <Choice label="Finished copies" value={value} options={OPTIONS} onChange={(m) => void save(m)} />
      <p className="text-[12px] leading-relaxed text-fg-muted" data-cleanup-hint>
        {CLEANUP_HINT[value]} Only copies Caprock made are ever removed — never the main checkout, a worktree you made, or a branch that is not
        merged. Branches are kept 7 days, so a removed copy can be restored from its project’s copies.
      </p>
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}
