/**
 * "Hooks not installed", on Now: what it means, a button that fixes it, and a
 * way to put it away.
 *
 * Without hooks Caprock still sees everything through the transcripts, a few
 * seconds late, so this is advice rather than an alarm. It used to ask the user
 * to copy a command into a terminal; now **Install hooks** runs the same
 * install (`POST /v1/hooks/install`, the code behind `caprock hooks install`)
 * and the banner reports what the settings file holds afterwards. The command
 * stays as a secondary line for anyone who would rather run it.
 *
 * It names the settings file it checked, because a preview daemon started
 * with a temporary HOME checks a different file from the user's own — and a
 * banner that does not say which file reads as a fault in the real one.
 *
 * The dismissal is keyed on the exact set of missing hook events: dismissing
 * "these 9 are missing" hides that, and the banner comes back only when the
 * set changes — hooks installed and then lost again, or a new event Caprock
 * registers that this machine does not have. Remembered per browser; storage
 * that throws only means it shows again.
 */
import { useState } from 'react'
import { api } from '@/lib/api'
import { Banner, BannerButton, BannerDismiss } from './Banner'

const KEY = 'caprock-hooks-banner-dismissed'

/** The dismissal key for a missing set: order-free, so a reshuffle is not a change. */
export function hooksKey(missing: string[]): string {
  return [...missing].sort().join(',')
}

function readDismissed(): string | null {
  try { return localStorage.getItem(KEY) } catch { return null }
}

/** What the success line says. Claude Code reads hooks when a session starts. */
export const INSTALLED_NOTE =
  'Sessions started from now on report live, including resumed ones. A session already running keeps the hooks it started with until it is restarted.'

/** `partial`: some hook events are installed already, so this is an update (a newer Caprock listens for more), not a first install. */
export function HooksBanner({ missing, settingsPath, partial = false }: { missing: string[]; settingsPath: string; partial?: boolean }) {
  const key = hooksKey(missing)
  const [dismissed, setDismissed] = useState(readDismissed)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  const [error, setError] = useState('')
  const [left, setLeft] = useState<string[]>([])
  if (dismissed === key) return null
  if (missing.length === 0 && state !== 'done') return null

  const dismiss = () => {
    try { localStorage.setItem(KEY, key) } catch { /* shows again next load */ }
    setDismissed(key)
  }
  const install = async () => {
    setState('busy')
    setError('')
    try {
      const r = await api.installHooks()
      const still = r.hooks.missing ?? []
      setLeft(still)
      if (still.length === 0) setState('done')
      else { setState('failed'); setError(`${still.length} still missing: ${still.join(', ')}`) }
    } catch (e) {
      setState('failed')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (state === 'done') {
    return (
      <Banner
        id="hooks"
        tone="ok"
        art="done"
        role="status"
        title="Hooks installed ✓"
        line={INSTALLED_NOTE}
        foot={<span className="mono block truncate" title={settingsPath}>in {settingsPath}</span>}
        actions={<BannerDismiss icon onClick={() => setDismissed(key)} aria-label="Close" />}
      />
    )
  }

  return (
    <Banner
      id="hooks"
      tone="warn"
      art="hooks"
      role="status"
      title={partial ? 'Hooks need an update' : 'Hooks not installed'}
      line={partial
        ? 'This Caprock listens for more hook events than are installed.'
        : 'Activity still arrives from transcripts, a few seconds late. Hooks make it live.'}
      foot={<>
        or run <span className="mono text-fg-muted">caprock hooks install</span> ·{' '}
        <span title={`Missing hook events: ${(left.length ? left : missing).join(', ')}`}>
          {missing.length} hook event{missing.length === 1 ? '' : 's'} missing in{' '}
        </span>
        <span className="mono break-all">{settingsPath}</span>
        {state === 'failed' && <span className="mt-1 block text-[11.5px] text-danger">Could not install: {error}</span>}
      </>}
      actions={<>
        <BannerButton onClick={install} disabled={state === 'busy'}>
          {state === 'busy' ? 'Installing…' : partial ? 'Update hooks' : 'Install hooks'}
        </BannerButton>
        <BannerDismiss icon onClick={dismiss} aria-label="Dismiss the hooks notice" title="Hide until the missing set changes" />
      </>}
    />
  )
}
