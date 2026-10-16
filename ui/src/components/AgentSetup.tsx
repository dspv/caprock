/**
 * What an agent is missing, and the way to fix it (ADR-046).
 *
 * The owner, 2026-10-10 (translated): "there's a model choice, and OpenCode
 * there is empty — either give buttons to connect it or remove it." An agent
 * that is not installed, or has no provider connected, now says so in a
 * sentence and offers the command that fixes it: copied with a click, or
 * typed into a new shell tab where the user reads it and presses Enter
 * themselves. Caprock never runs an install on the user's behalf.
 */
import type { CatalogEntry } from '@/lib/api'
import { Copyable } from './ui'
import { extTitle } from '@/lib/externalLinks'

export function AgentSetupNote({
  entry,
  onSetup,
}: {
  entry: CatalogEntry
  /** Opens a shell tab with the command typed, not run. Absent where there are no tabs (the dashboard). */
  onSetup?: (command: string) => void
}) {
  const s = entry.setup
  if (!s) return null
  const blocking = s.reason === 'not_installed'
  return (
    <div role="note" aria-label={`${entry.label} setup`} className={`grid min-w-0 gap-2 rounded-[8px] border px-3 py-2.5 ${blocking ? 'border-[var(--app-hairline-strong)] bg-[var(--app-row-hover)]' : 'border-[var(--app-hairline)]'}`}>
      <p className="text-[12.5px] leading-snug text-fg">{s.text}</p>
      {s.command && <Copyable command={s.command} className="min-w-0 max-w-full truncate" />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {s.command && onSetup && (
          <button
            type="button"
            onClick={() => onSetup(s.command!)}
            className="h-[28px] rounded-[7px] bg-accent px-3 text-[12.5px] font-medium text-panel hover:brightness-110"
          >
            {s.reason === 'not_installed' ? 'Install in a shell tab' : s.reason === 'no_provider' ? 'Connect a provider' : 'Sign in in a shell tab'}
          </button>
        )}
        {s.docs && (
          <a href={s.docs} target="_blank" title={extTitle()} rel="noreferrer" className="text-[12px] text-fg-muted underline-offset-2 hover:text-fg hover:underline">
            {entry.label} docs
          </a>
        )}
      </div>
      {s.command && onSetup && (
        <p className="text-[11.5px] leading-snug text-fg-faint">
          The command is typed into a new shell tab, not run: read it, then press Enter.{blocking ? ' Come back here once it is installed.' : ''}
        </p>
      )}
    </div>
  )
}

/** Says, for an agent whose sessions Caprock does not read, what it does and does not show. */
export function AgentObservedNote({ entry }: { entry?: CatalogEntry }) {
  if (!entry || entry.observed || !entry.installed) return null
  return (
    <p className="text-[11.5px] leading-snug text-fg-faint">
      Caprock starts {entry.label} in a terminal tab and keeps the session in your list; it does not read its turns or cost.
    </p>
  )
}
