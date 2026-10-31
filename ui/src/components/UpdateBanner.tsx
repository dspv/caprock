/**
 * UpdateBanner — tells you a newer Caprock exists, and hands you the exact
 * command to install it.
 *
 * There is deliberately no "update now" button. Upgrading replaces the running
 * binary, so the daemon would be killing the process running the command; and
 * executing a package manager on your behalf from a web page is precisely the
 * surface a local-first tool should not open. You copy one line and run it in
 * your own terminal, where you can see exactly what it does.
 *
 * In the desktop app, when this install can replace itself, the banner is
 * the same one click as the status strip's update line (AppUpdateNotice):
 * **Update to vX.Y.Z — Restart** downloads with a progress bar, verifies,
 * installs and relaunches (ADR-042), instead of a link to the release page
 * (owner, 2026-10-31, translated: "seamless, not through a link to GitHub").
 *
 * The check reaches GitHub for a version number and nothing else, so it is off until
 * you turn it on — this component is also where you turn it on, and off again.
 */
import { useEffect, useState } from 'react'
import { api, isPairedDevice, type Settings, type UpdateStatus } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { Copyable } from '@/components/ui'
import { everyWhileVisible } from '@/lib/visible'
import { isTauri } from '@/lib/appmode'
import { Banner, BannerButton, BannerDismiss } from './Banner'
import { extTitle } from '@/lib/externalLinks'
import { appUpdate, offerFor, useAppUpdate } from '@/lib/appupdate'

const DISMISS_KEY = 'caprock.update.dismissed'

export function UpdateBanner({ plan, onSave, now, owned = 0 }: {
  plan?: Settings
  onSave: (patch: Partial<Settings>) => void
  now: number
  /** Live sessions Caprock started that upgrading will close: those not in a pty-host. */
  owned?: number
}) {
  const [st, setSt] = useState<UpdateStatus>()
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) ?? '')
  const info = useAppUpdate()

  // Reading status never triggers a network call — the daemon serves a cached
  // answer — so this is safe to poll gently.
  useEffect(() => {
    if (!plan?.update_checks) { setSt(undefined); return }
    let alive = true
    const load = () => { void api.update().then((s) => { if (alive) setSt(s) }).catch(() => {}) }
    load()
    const stop = everyWhileVisible(load, 60_000)
    return () => { alive = false; stop() }
  }, [plan?.update_checks])

  // The offer to switch checking on, shown once until dismissed.
  if (plan && !plan.update_checks) {
    // Switching the check on is a settings change, which a paired device may
    // not make (ADR-029).
    if (dismissed === 'offer' || isPairedDevice()) return null
    // The desktop app asks its own question once, on its first launch
    // (AppUpdateAsk); a second offer here would be asking twice.
    if (isTauri()) return null
    return (
      <Banner
        id="update"
        art="update"
        title="Know when a new Caprock is out"
        line="Off until you turn it on. It asks GitHub for one version number and sends no usage data."
        actions={<>
          <BannerButton onClick={() => onSave({ update_checks: true })}>Check for updates</BannerButton>
          <BannerDismiss onClick={() => { localStorage.setItem(DISMISS_KEY, 'offer'); setDismissed('offer') }}>No thanks</BannerDismiss>
        </>}
      />
    )
  }

  // The app's own updater, when it can replace this install: the strip's
  // offer, so the banner and the strip never disagree about what a click does.
  const app = info?.supported ? offerFor(info, st, dismissed) : undefined
  const busy = app?.kind === 'progress' || app?.kind === 'installing'
  if (!busy && app?.kind !== 'failed') {
    if (!st?.update_available || !st.latest) return null
    if (dismissed === st.latest) return null
  }
  if (!st?.latest && !busy && app?.kind !== 'failed') return null
  const next = app && (app.kind === 'install' || app.kind === 'progress' || app.kind === 'installing') ? app.next : st?.latest ?? ''
  const notNow = () => { localStorage.setItem(DISMISS_KEY, next); setDismissed(next) }

  return (
    <Banner
      id="update"
      art="update"
      title={app?.kind === 'progress' ? <>Downloading Caprock {next}</> : app?.kind === 'installing' ? <>Installing Caprock {next} — restarting…</> : app?.kind === 'failed' ? <>The update did not install</> : <>Caprock {next} is available</>}
      line={<>
        {app?.kind === 'failed' ? <span className="text-warn">{app.error}</span> : <>
          You&apos;re on <span className="mono">{st?.current ?? info?.version}</span>
          {st?.checked_at ? <span className="text-fg-faint"> · checked {fmtAgo(st.checked_at, now)}</span> : null}
          {app?.kind === 'install' && <span className="text-fg-faint"> · restarting keeps every session in a terminal running</span>}
        </>}
        {/* Upgrading restarts the daemon. A session whose terminal is in a
          * pty-host carries on and is picked back up (ADR-033); one in the
          * daemon's own PTY ends with it. Counted, and only shown when there
          * are any: finding out afterwards is how a user loses a turn. */}
        {owned > 0 && (
          <span className="text-warn"> · {owned === 1 ? '1 session Caprock started will close' : `${owned} sessions Caprock started will close`}</span>
        )}
      </>}
      actions={<>
        {app?.kind === 'install' || app?.kind === 'failed' ? (
          <BannerButton onClick={() => { void appUpdate.install() }}>{app.kind === 'failed' ? 'Try again' : <>Update to {next} — Restart</>}</BannerButton>
        ) : app?.kind === 'progress' ? (
          <span role="status" data-update-banner-progress className="inline-flex items-center gap-2 whitespace-nowrap text-fg-muted" title="Downloading in the background; sessions keep running">
            <span className="relative h-[6px] w-[140px] overflow-hidden rounded-full bg-[var(--app-hairline-strong)]">
              <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-200" style={{ width: `${app.pct ?? 8}%` }} />
            </span>
            {app.pct !== null && <span className="num text-fg">{app.pct}%</span>}
          </span>
        ) : app?.kind === 'checking' ? (
          <BannerButton disabled>Checking…</BannerButton>
        ) : app?.kind === 'installing' ? null : st?.command ? (
          <Copyable command={st.command} className="max-w-full truncate" />
        ) : (
          <a className="bn-btn bg-accent text-bg no-underline" href={st?.url} target="_blank" title={extTitle()} rel="noreferrer">Download it</a>
        )}
        {st?.url && <a className="bn-link no-underline" href={st.url} target="_blank" title={extTitle()} rel="noreferrer">What&apos;s new</a>}
        {!busy && <BannerDismiss onClick={notNow}>Not now</BannerDismiss>}
      </>}
    />
  )
}
