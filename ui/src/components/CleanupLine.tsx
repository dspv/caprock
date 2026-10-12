/**
 * Finished copies, on one quiet line (owner-approved design, 2026-10-12):
 * the project's page and the deck's Branches view say "3 copies done ·
 * 2.1 GB · Clean up", never the sidebar.
 *
 * A finished copy is one Caprock made that is merged (or its pull request
 * is), pushed, clean and has nothing running in it — the daemon decides
 * (`GET /v1/projects/{id}/cleanup`, internal/projects/cleanup.go). *Clean up*
 * confirms inline, on the same line, and removes exactly the copies listed;
 * *Review* opens the copies sheet with them ticked. In Auto mode the line
 * says when they go. Once copies are removed the line says so for a day with
 * *Undo*, which puts them back from their kept branches.
 *
 * Nothing here polls the daemon except while sizes are being measured.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { errText } from '@/lib/api'
import { copiesText, dueText, freedOf, type CleanupView } from '@/lib/copies'
import { fmtBytes } from '@/lib/format'
import { projectsApi } from '@/lib/projects'

const POLL_MS = 1500
const DISMISS_KEY = 'caprock.cleanup.dismissed.'

function readDismissed(projectId: string): number {
  try {
    return Number(localStorage.getItem(DISMISS_KEY + projectId)) || 0
  } catch {
    return 0
  }
}

function writeDismissed(projectId: string, at: number) {
  try {
    localStorage.setItem(DISMISS_KEY + projectId, String(at))
  } catch {
    // A private window: the line comes back next time, which is harmless.
  }
}

export function CleanupLine({ projectId, refreshKey, onReview, onRemoved, compact = false, className = '' }: {
  projectId: string
  /** Changes when the project's worktrees do: the line asks again. */
  refreshKey?: string
  /** Opens the copies sheet with these paths ticked. */
  onReview: (paths: string[]) => void
  /** Copies were removed (here or by Auto): tabs on them close. */
  onRemoved?: (paths: string[]) => void
  /** The deck's smaller type. */
  compact?: boolean
  className?: string
}) {
  const [view, setView] = useState<CleanupView | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'' | 'clean' | 'undo'>('')
  const [error, setError] = useState('')
  const [dismissed, setDismissed] = useState(() => readDismissed(projectId))
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const removedRef = useRef(onRemoved)
  removedRef.current = onRemoved

  const load = useCallback(async () => {
    try {
      const v = await projectsApi.cleanup(projectId)
      if (!alive.current) return
      setView(v)
      if (v.removed.length > 0) removedRef.current?.(v.removed.map((r) => r.path))
    } catch {
      if (alive.current) setView(null)
    }
  }, [projectId])

  useEffect(() => { void load() }, [load, refreshKey])
  useEffect(() => { setDismissed(readDismissed(projectId)); setConfirming(false); setError('') }, [projectId])
  useEffect(() => {
    if (!view?.pending) return
    const t = setTimeout(() => void load(), POLL_MS)
    return () => clearTimeout(t)
  }, [view, load])

  if (!view || view.mode === 'off') return null
  const removed = view.removed.filter((r) => r.at > dismissed)
  const cands = view.candidates
  if (removed.length === 0 && cands.length === 0 && !error) return null

  const size = view.pending && view.total === 0 ? '…' : fmtBytes(view.total)
  const due = view.mode === 'auto' ? Math.min(...cands.map((c) => c.due ?? Infinity)) : Infinity

  const clean = async () => {
    setBusy('clean')
    setError('')
    try {
      const res = await projectsApi.cleanUp(projectId, cands.map((c) => c.path))
      if (!alive.current) return
      setView(res.cleanup)
      setConfirming(false)
      const gone = res.results.filter((r) => r.removed).map((r) => r.path)
      if (gone.length > 0) onRemoved?.(gone)
      const failed = res.results.filter((r) => !r.removed)
      if (failed.length > 0) setError(`${copiesText(failed.length)} kept: ${failed[0]!.error ?? 'it changed'}`)
    } catch (e) {
      if (alive.current) setError(`Could not clean up: ${errText(e)}`)
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const undo = async () => {
    setBusy('undo')
    setError('')
    try {
      const res = await projectsApi.restoreCopies(projectId, removed.map((r) => r.id))
      if (!alive.current) return
      setView(res.cleanup)
      const failed = res.results.filter((r) => !r.restored)
      if (failed.length > 0) setError(`Could not restore ${copiesText(failed.length)}: ${failed[0]!.error ?? ''}`)
    } catch (e) {
      if (alive.current) setError(`Could not undo: ${errText(e)}`)
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const dismiss = () => {
    const at = Math.max(...removed.map((r) => r.at))
    writeDismissed(projectId, at)
    setDismissed(at)
  }

  const link = 'text-accent hover:underline disabled:opacity-60 disabled:no-underline'
  const dot = <span aria-hidden className="text-fg-faint">·</span>

  return (
    <div className={`grid gap-0.5 ${compact ? 'text-[11.5px]' : 'text-[12.5px]'} text-fg-muted ${className}`} data-cleanup-line>
      {removed.length > 0 && (
        <p role="status" className="flex flex-wrap items-baseline gap-x-1.5" data-cleanup-removed>
          <span>Removed {copiesText(removed.length)}</span>
          {freedOf(removed) > 0 && <>{dot}<span><span className="num">{fmtBytes(freedOf(removed))}</span> freed</span></>}
          {dot}
          <button type="button" className={link} disabled={!!busy} onClick={() => void undo()}>
            {busy === 'undo' ? 'Restoring…' : 'Undo'}
          </button>
          <button type="button" aria-label="Hide this line" title="Hide" className="ml-0.5 text-fg-faint hover:text-fg" onClick={dismiss}>×</button>
        </p>
      )}
      {cands.length > 0 && !confirming && (
        <p className="flex flex-wrap items-baseline gap-x-1.5" data-cleanup-ask title={cands.map((c) => c.branch).join(', ')}>
          <span>{copiesText(cands.length)} done</span>
          {dot}
          <span className="num">{size}</span>
          {Number.isFinite(due) && <>{dot}<span>removed {dueText(due, Date.now())}</span></>}
          {dot}
          <button type="button" className={link} disabled={!!busy} onClick={() => setConfirming(true)}>
            {view.mode === 'auto' ? 'Clean up now' : 'Clean up'}
          </button>
          {dot}
          <button type="button" className="text-fg-muted hover:text-fg hover:underline" onClick={() => onReview(cands.map((c) => c.path))}>
            Review
          </button>
        </p>
      )}
      {cands.length > 0 && confirming && (
        <p className="flex flex-wrap items-baseline gap-x-2" role="group" aria-label="Confirm clean up" data-cleanup-confirm>
          <span className="text-fg">
            Remove {copiesText(cands.length)}{view.total > 0 ? ` (${fmtBytes(view.total)})` : ''}?
          </span>
          <span className="text-fg-faint">Branches stay 7 days.</span>
          <button type="button" className="font-medium text-danger hover:underline disabled:opacity-60" disabled={!!busy} onClick={() => void clean()}>
            {busy === 'clean' ? 'Removing…' : 'Remove'}
          </button>
          <button type="button" className="text-fg-muted hover:text-fg hover:underline" disabled={!!busy} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </p>
      )}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>
  )
}
