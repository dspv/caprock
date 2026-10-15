/**
 * Settings → Updates (owner, 2026-10-15, translated: "check for a new
 * version a bit more often, and add an option — turn on auto-update, or ask
 * the user").
 *
 * - **The release check** (`update_checks`, rule 4's one standing outbound
 *   call): off until switched on; once an hour while Caprock runs and on
 *   waking, a conditional request to GitHub. Moved here from Privacy, which
 *   still names it.
 * - **When it was last asked, and Check now** — the daemon's check and, in
 *   the app, the app's own updater, as the version panel's button does.
 * - **In the desktop app, where it can replace itself: Ask me / Update
 *   automatically** (`app_update`, ADR-042 as amended 2026-10-15). Choosing
 *   automatic also switches the release check on, which it cannot work
 *   without, and says so. Anywhere else the update is the command for how
 *   Caprock was installed (the version panel) and there is no choice here.
 */
import { useEffect, useState } from 'react'
import { api, type AppUpdateMode, type UpdateStatus } from '@/lib/api'
import { newerVersion, useAppUpdate, v } from '@/lib/appupdate'
import { isTauri } from '@/lib/appmode'
import { checkByHand } from '@/lib/checkbanner'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { usePlan } from './PlanPicker'
import { Choice, Section, Toggle } from './SettingsParts'

const MODES: { value: AppUpdateMode; label: string }[] = [
  { value: 'ask', label: 'Ask me' },
  { value: 'auto', label: 'Update automatically' },
]

export const APP_UPDATE_HINT: Record<AppUpdateMode, string> = {
  ask: 'A card in the corner says a new version is out. Nothing installs until you click Update.',
  auto: 'Caprock downloads it in the background and restarts into it when no agent is working or waiting for your answer, you have left the app alone for 2 minutes, and nothing typed is waiting to be sent. Ten seconds’ notice first, with Not now. Sessions and tabs stay as they are.',
}

export function UpdatesSetting() {
  const [plan, savePlan] = usePlan()
  const info = useAppUpdate()
  const [st, setSt] = useState<UpdateStatus>()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const now = useNow(30_000)
  const checks = !!plan?.update_checks
  useEffect(() => {
    let alive = true
    api.update().then((s) => { if (alive) setSt(s) }).catch(() => { /* an older daemon */ })
    return () => { alive = false }
  }, [checks])
  if (!plan) return null

  const mode: AppUpdateMode = plan.app_update === 'auto' ? 'auto' : 'ask'
  const app = isTauri() ? info : undefined
  const shown = info?.version ? v(info.version) : st?.current
  const latest = st?.enabled && st.latest ? v(st.latest) : undefined
  const out = !!(latest && shown && newerVersion(latest, shown))

  const check = async () => {
    setChecking(true)
    setError('')
    try {
      // Up to date, or the error with Retry, is the banner's (lib/checkbanner).
      const s = await checkByHand()
      if (s) setSt(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setChecking(false)
    }
  }
  const pick = (m: AppUpdateMode) => {
    // Automatic needs to hear of a release; the hint says the check comes on.
    savePlan(m === 'auto' ? { app_update: m, update_checks: true } : { app_update: m })
  }

  return (
    <Section id="settings-updates" title="Updates">
      <Toggle
        checked={checks}
        onChange={(on) => savePlan({ update_checks: on })}
        label="Tell me when a new version is out"
        hint="Once an hour while Caprock runs, and when the computer wakes, it asks GitHub for the latest version number. Nothing about you is sent, and nothing goes to us."
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px]">
        <span className="text-fg-muted" data-update-checked>
          {!checks
            ? 'Checks are off.'
            : out
              ? <><span className="font-medium text-accent">{latest} is out</span> · you have <span className="mono">{shown}</span></>
              : st?.checked_at
                ? `Up to date · checked ${fmtAgo(st.checked_at, now)}`
                : 'Not checked yet'}
        </span>
        <button
          type="button"
          onClick={() => void check()}
          disabled={checking || !checks}
          className="rounded-[7px] border border-[var(--app-hairline-strong)] px-2.5 py-1 text-[12.5px] text-fg hover:border-accent disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {error && <p className="break-words text-[12px] text-warn">{error}</p>}
      {app?.supported && (
        <>
          <Choice label="New version" value={mode} options={MODES} onChange={pick} />
          <p className="text-[12px] leading-relaxed text-fg-muted" data-app-update-hint>
            {APP_UPDATE_HINT[mode]}
            {mode === 'auto' && !checks && ' Choosing it turns the check above on.'}
          </p>
        </>
      )}
      {app && !app.supported && app.blocked && (
        <p className="text-[12px] leading-relaxed text-fg-muted">This copy cannot update itself: {app.blocked}</p>
      )}
    </Section>
  )
}
