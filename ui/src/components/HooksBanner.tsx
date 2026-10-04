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

export function HooksBanner({ missing, settingsPath }: { missing: string[]; settingsPath: string }) {
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

  const close = (
    <button type="button" onClick={dismiss} aria-label="Dismiss the hooks notice"
      className="-mr-1 self-start px-1.5 text-[15px] leading-none text-fg-faint hover:text-fg">
      ×
    </button>
  )

  if (state === 'done') {
    return (
      <div role="status" className="border border-ok/50 bg-ok/10 px-3 py-2 text-[12px] rounded-[var(--radius-panel)] flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <span className="text-ok font-medium">Hooks installed ✓</span>{' '}
          <span className="text-fg-muted">{INSTALLED_NOTE}</span>
          <div className="mono text-[10.5px] text-fg-faint truncate" title={settingsPath}>in {settingsPath}</div>
        </div>
        <button type="button" onClick={() => setDismissed(key)} aria-label="Close" className="-mr-1 px-1.5 text-[15px] leading-none text-fg-faint hover:text-fg">×</button>
      </div>
    )
  }

  return (
    <div role="status" className="border border-warn/50 bg-warn/10 px-3 py-2 text-[12px] rounded-[var(--radius-panel)] flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-warn font-medium">Hooks not installed</span>
          <span className="text-fg-muted min-w-0">
            Activity still arrives from transcripts, a few seconds late. Hooks make it live.
          </span>
          <button type="button" onClick={install} disabled={state === 'busy'}
            className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-panel hover:opacity-90 disabled:opacity-60">
            {state === 'busy' ? 'Installing…' : 'Install hooks'}
          </button>
        </div>
        <div className="mt-1 text-[11px] text-fg-faint">
          or run <span className="mono text-fg-muted">caprock hooks install</span> in a terminal ·{' '}
          <span title={`Missing hook events: ${(left.length ? left : missing).join(', ')}`}>
            {missing.length} hook event{missing.length === 1 ? '' : 's'} missing in{' '}
          </span>
          <span className="mono break-all">{settingsPath}</span>
        </div>
        {state === 'failed' && <div className="mt-1 text-[11.5px] text-danger">Could not install: {error}</div>}
      </div>
      {close}
    </div>
  )
}
