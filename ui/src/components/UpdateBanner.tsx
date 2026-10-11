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

  if (!st?.update_available || !st.latest) return null
  if (dismissed === st.latest) return null

  return (
    <Banner
      id="update"
      art="update"
      title={<>Caprock {st.latest} is available</>}
      line={<>
        You&apos;re on <span className="mono">{st.current}</span>
        {st.checked_at ? <span className="text-fg-faint"> · checked {fmtAgo(st.checked_at, now)}</span> : null}
        {/* Upgrading restarts the daemon. A session whose terminal is in a
          * pty-host carries on and is picked back up (ADR-033); one in the
          * daemon's own PTY ends with it. Counted, and only shown when there
          * are any: finding out afterwards is how a user loses a turn. */}
        {owned > 0 && (
          <span className="text-warn"> · {owned === 1 ? '1 session Caprock started will close' : `${owned} sessions Caprock started will close`}</span>
        )}
      </>}
      actions={<>
        {st.command ? (
          <Copyable command={st.command} className="max-w-full truncate" />
        ) : (
          <a className="bn-btn bg-accent text-bg no-underline" href={st.url} target="_blank" rel="noreferrer">Download it</a>
        )}
        <a className="bn-link no-underline" href={st.url} target="_blank" rel="noreferrer">What&apos;s new</a>
        <BannerDismiss onClick={() => { localStorage.setItem(DISMISS_KEY, st.latest!); setDismissed(st.latest!) }}>Not now</BannerDismiss>
      </>}
    />
  )
}
