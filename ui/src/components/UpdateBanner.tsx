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
 * The check itself is the only outbound call Caprock makes, so it is off until
 * you turn it on — this component is also where you turn it on, and off again.
 */
import { useEffect, useState } from 'react'
import { api, type Settings, type UpdateStatus } from '@/lib/api'
import { fmtAgo } from '@/lib/format'

const DISMISS_KEY = 'caprock.update.dismissed'

export function UpdateBanner({ plan, onSave, now }: {
  plan?: Settings
  onSave: (s: Settings) => void
  now: number
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
    const id = window.setInterval(load, 60_000)
    return () => { alive = false; window.clearInterval(id) }
  }, [plan?.update_checks])

  // The offer to switch checking on, shown once until dismissed.
  if (plan && !plan.update_checks) {
    if (dismissed === 'offer') return null
    return (
      <Frame tone="muted">
        <span className="text-fg-muted">
          Caprock can check GitHub for new releases. It&apos;s the only outbound
          call it makes, so it&apos;s off unless you turn it on — no usage data
          is sent, and you can turn it off again any time.
        </span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <button
            className="text-[11px] border border-accent/50 text-accent bg-accent/10 px-2 py-0.5 rounded-sm hover:bg-accent/20"
            onClick={() => onSave({ ...plan, update_checks: true })}
          >
            check for updates
          </button>
          <button
            className="text-[11px] text-fg-faint hover:text-fg border border-border px-1.5 py-0.5 rounded-sm"
            onClick={() => { localStorage.setItem(DISMISS_KEY, 'offer'); setDismissed('offer') }}
          >
            no thanks
          </button>
        </span>
      </Frame>
    )
  }

  if (!st?.update_available || !st.latest) return null
  if (dismissed === st.latest) return null

  return (
    <Frame tone="accent">
      <span className="text-fg">
        <span className="font-medium">Caprock {st.latest}</span> is available —
        you&apos;re on <span className="mono">{st.current}</span>.
      </span>
      {st.command ? (
        <Copyable command={st.command} />
      ) : (
        <a className="link text-[12px]" href={st.url} target="_blank" rel="noreferrer">
          download it
        </a>
      )}
      <span className="ml-auto flex items-center gap-2 shrink-0">
        {st.checked_at ? (
          <span className="num text-[11px] text-fg-faint">checked {fmtAgo(st.checked_at, now)}</span>
        ) : null}
        <a
          className="text-[11px] text-fg-muted hover:text-fg border border-border px-1.5 py-0.5 rounded-sm no-underline"
          href={st.url}
          target="_blank"
          rel="noreferrer"
        >
          what&apos;s new
        </a>
        <button
          className="text-[11px] text-fg-faint hover:text-fg border border-border px-1.5 py-0.5 rounded-sm"
          onClick={() => { localStorage.setItem(DISMISS_KEY, st.latest!); setDismissed(st.latest!) }}
        >
          not now
        </button>
      </span>
    </Frame>
  )
}

function Copyable({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="mono text-[12px] bg-panel-2 border border-border px-2 py-0.5 rounded-sm hover:border-border-strong text-fg shrink-0"
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
      title="copy to clipboard — run it in your terminal"
    >
      {copied ? 'copied' : `$ ${command}`}
    </button>
  )
}

function Frame({ tone, children }: { tone: 'accent' | 'muted'; children: React.ReactNode }) {
  const cls = tone === 'accent' ? 'border-accent/40 bg-accent/5' : 'border-border bg-panel'
  return (
    <div className={`border rounded-[var(--radius-panel)] px-3 py-2 flex items-center gap-3 text-[12px] ${cls}`}>
      {children}
    </div>
  )
}
