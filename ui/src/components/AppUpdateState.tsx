/**
 * What the app's own updater is doing, and the terminal commands, as the
 * version panel (VersionPanel) and the status strip's update panel
 * (AppUpdateNotice) both say it.
 *
 * The commands are for an install that cannot replace itself (`commands`)
 * and, labelled as the other way, under a failed update. Never while the
 * app checks, downloads or installs the update itself (owner, 2026-11-23:
 * *Run in a terminal: brew update && brew upgrade --cask caprock-app* sat
 * under a download the app was doing on its own — "scary and wrong").
 */
import type { Offer } from '@/lib/appupdate'
import { Copyable } from './ui'

export function UpdateCommands({ commands, fallback = false }: {
  commands: { label: string; command: string }[]
  /** Under a failed update: the other way, not the way. */
  fallback?: boolean
}) {
  if (commands.length === 0) return null
  return (
    <div className="grid gap-1.5" data-update-commands={fallback ? 'fallback' : 'primary'}>
      <p className="text-fg-muted">{fallback ? 'Or update from a terminal:' : 'Run in a terminal:'}</p>
      {commands.map((c) => (
        <div key={c.command} className="grid gap-0.5">
          {commands.length > 1 && <span className="text-[11px] text-fg-faint">{c.label}</span>}
          <Copyable command={c.command} className="break-all" />
        </div>
      ))}
    </div>
  )
}

/** Checking, downloading (with a thin bar) or installing; nothing for any other offer. */
export function AppUpdateProgress({ offer }: { offer: Offer }) {
  switch (offer.kind) {
    case 'checking':
      return <p role="status" data-app-update-state="checking" className="text-fg-muted">Checking for the app update…</p>
    case 'progress':
      return (
        <div role="status" data-app-update-state="progress" className="grid gap-1">
          <span className="text-fg">
            Downloading <span className="mono">{offer.next}</span>…{offer.pct !== null && <> <span className="num">{offer.pct}%</span></>}
          </span>
          <span className="relative h-[4px] overflow-hidden rounded-full bg-[var(--app-hairline-strong)]">
            <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-200" style={{ width: `${offer.pct ?? 8}%` }} />
          </span>
        </div>
      )
    case 'installing':
      return (
        <p role="status" data-app-update-state="installing" className="text-fg">
          Installing <span className="mono">{offer.next}</span> — the app restarts, sessions keep running
        </p>
      )
    default:
      return null
  }
}
