/**
 * Where Second Brain keeps what it learns (owner, 2026-10-15): the database
 * file — the real path, as the daemon resolved it from its data directory
 * (`db_path` on GET /v1/brain/status), never a per-OS guess — the three
 * tables the memories live in, and what leaves the machine. Shown in the
 * screen's Settings and under *Details* in How it works.
 *
 * There is no "Show in folder": nothing in Caprock reveals a file in Finder
 * or Explorer yet, and this block does not add an OS dialog for it. *Copy
 * path* puts the path on the clipboard instead.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

export const BRAIN_TABLES = ['brain_nodes', 'brain_edges', 'brain_runs'] as const
export const BRAIN_LEAVES = 'The session text goes to Anthropic through your own Claude to be read; nothing goes to Caprock.'
// The privacy filter (internal/redact): what is sent to be read and what is
// kept are both run through it.
export const BRAIN_FILTERED = 'Card numbers, keys and passwords are removed before anything is sent or saved.'

export function BrainWhere({ dbPath, className = '' }: { dbPath?: string; className?: string }) {
  // Asked once when the caller has no status at hand (How it works).
  const [asked, setAsked] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (dbPath !== undefined) return
    let live = true
    api.brainStatus().then((s) => { if (live) setAsked(s.db_path ?? '') }, () => { if (live) setAsked('') })
    return () => { live = false }
  }, [dbPath])
  const path = dbPath ?? asked
  const copy = () => {
    if (!path) return
    navigator.clipboard?.writeText(path).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }, () => {})
  }
  return (
    <div className={`grid min-w-0 gap-1 text-left text-[12.5px] leading-snug text-fg ${className}`} data-brain-where>
      <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-muted">Where it’s kept</p>
      <div className="flex min-w-0 items-start gap-2">
        <code className="mono min-w-0 flex-1 break-all text-[12px] text-fg" data-brain-db-path>{path === undefined ? '…' : path || 'caprock.db in Caprock’s data folder'}</code>
        {path && (
          <button type="button" onClick={copy} className="shrink-0 text-[12px] text-accent hover:underline" data-brain-db-copy>
            {copied ? 'Copied' : 'Copy path'}
          </button>
        )}
      </div>
      <p className="text-fg-muted">Tables: {BRAIN_TABLES.map((t, i) => <span key={t}>{i > 0 && ' · '}<code className="mono text-[12px]">{t}</code></span>)}</p>
      <p className="text-fg-muted" data-brain-leaves>{BRAIN_LEAVES}</p>
      <p className="text-fg-muted" data-brain-filtered>{BRAIN_FILTERED}</p>
    </div>
  )
}
