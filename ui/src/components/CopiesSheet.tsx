/**
 * Clean up copies: every git worktree of a project — the main checkout,
 * Caprock's copies and any made by hand — with its branch, newest commit,
 * what removing it would lose, and its size on disk; pick some and remove
 * them (lib/copies, `GET /v1/projects/{id}/copies`).
 *
 * The rules, which the daemon applies again on its side:
 * - only a copy Caprock made is removed; the main checkout never, one made by
 *   hand never (it says to use git), a locked one never;
 * - a copy with a session or a shell running in it is not removed — it says
 *   what runs (rule 7: nothing here stops a process);
 * - a copy with uncommitted changes, commits no remote has or commits on no
 *   branch needs a second confirmation that lists exactly that, per copy;
 * - "Also delete merged branches" deletes a copy's local branch only when
 *   every commit on it is in the default branch.
 *
 * Sizes are measured in the background; "…" until then, polled while any is.
 *
 * Below the list, *Recently removed*: what was removed here or by the
 * finished-copies cleanup (components/CleanupLine), when, and how much it
 * freed, with *Restore* for 7 days — the branch is kept that long. A copy
 * of Caprock's with no commit for 14 days and no pull request is tagged
 * `stale`: a suggestion, never removed for it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errText } from '@/lib/api'
import { baseOf, blockedReason, isSafePick, lossOf, shortPath, sizeText, type CleanupRecord, type CopiesView, type CopyRemoved, type ProjectCopy } from '@/lib/copies'
import { fmtAgo, fmtBytes } from '@/lib/format'
import { projectsApi } from '@/lib/projects'
import { Sheet, SheetButton } from './Sheet'

const POLL_MS = 1500

export function CopiesSheet({ projectId, name, onClose, onChanged, preselect }: {
  projectId: string
  name: string
  onClose: () => void
  /** Copies were removed or restored: the sidebar's list is stale. */
  onChanged?: () => void
  /** Paths ticked when the list first arrives (Review on the cleanup line). */
  preselect?: string[]
}) {
  const [view, setView] = useState<CopiesView | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [history, setHistory] = useState<CleanupRecord[]>([])
  const [restoring, setRestoring] = useState('')
  const preselected = useRef(false)
  const [deleteBranches, setDeleteBranches] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<{ removed: CopyRemoved[]; failed: CopyRemoved[]; freed: number } | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    try {
      const v = await projectsApi.copies(projectId)
      if (!alive.current) return
      setView(v)
      setError('')
      // A copy that went away or became unremovable drops out of the pick.
      setPicked((cur) => {
        const ok = new Set(v.copies.filter((c) => blockedReason(c) === null).map((c) => c.path))
        if (!preselected.current && preselect?.length) {
          preselected.current = true
          return new Set(preselect.filter((p) => ok.has(p)))
        }
        const next = new Set([...cur].filter((p) => ok.has(p)))
        return next.size === cur.size ? cur : next
      })
    } catch (e) {
      if (alive.current) setError(`Could not list the copies: ${errText(e)}`)
    }
    try {
      const c = await projectsApi.cleanup(projectId)
      if (alive.current) setHistory(c.history)
    } catch {
      // An older daemon has no history; the list stands without it.
    }
  }, [projectId, preselect])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!view?.pending) return
    const t = setTimeout(() => void load(), POLL_MS)
    return () => clearTimeout(t)
  }, [view, load])

  const hasRemote = !!view?.has_remote
  const linked = useMemo(() => (view?.copies ?? []).filter((c) => !c.main), [view])
  const chosen = useMemo(() => (view?.copies ?? []).filter((c) => picked.has(c.path)), [view, picked])
  const risky = useMemo(() => chosen.filter((c) => lossOf(c, hasRemote).length > 0), [chosen, hasRemote])
  const safe = useMemo(() => linked.filter((c) => isSafePick(c, hasRemote)), [linked, hasRemote])
  const chosenSize = chosen.reduce((n, c) => n + (c.size ?? 0), 0)

  const toggle = (path: string) => {
    setResults(null)
    setConfirming(false)
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const remove = async () => {
    if (chosen.length === 0) return
    if (risky.length > 0 && !confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      const asks = chosen.map((c) => ({ path: c.path, force: confirming && lossOf(c, hasRemote).length > 0 }))
      const res = await projectsApi.removeCopies(projectId, asks, deleteBranches)
      const sizes = new Map(chosen.map((c) => [c.path, c.size ?? 0]))
      const removed = res.filter((r) => r.removed)
      setResults({ removed, failed: res.filter((r) => !r.removed || r.error), freed: removed.reduce((n, r) => n + (sizes.get(r.path) ?? 0), 0) })
      setPicked(new Set(res.filter((r) => !r.removed).map((r) => r.path)))
      setConfirming(false)
      if (removed.length > 0) onChanged?.()
      await load()
    } catch (e) {
      setError(`Could not remove: ${errText(e)}`)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const restore = async (r: CleanupRecord) => {
    setRestoring(r.id)
    setError('')
    try {
      const res = await projectsApi.restoreCopies(projectId, [r.id])
      const failed = res.results.find((x) => !x.restored)
      if (failed) setError(`Could not restore ${baseOf(r.path)}: ${failed.error ?? ''}`)
      else onChanged?.()
      await load()
    } catch (e) {
      setError(`Could not restore: ${errText(e)}`)
    } finally {
      if (alive.current) setRestoring('')
    }
  }

  const label = (c: ProjectCopy) => c.branch || (c.head ? `detached at ${c.head.slice(0, 7)}` : c.name || c.path)
  const totalText = !view ? '' : view.pending && view.total === 0 ? '…' : `${view.capped ? '≥ ' : ''}${fmtBytes(view.total)}${view.pending ? ' so far' : ''}`

  const footer = confirming ? (
    <>
      <SheetButton onClick={() => setConfirming(false)}>Back</SheetButton>
      <button
        type="button"
        disabled={busy}
        onClick={() => void remove()}
        className="inline-flex h-[34px] items-center rounded-[7px] bg-danger px-4 text-[14px] font-semibold text-panel hover:brightness-110 disabled:opacity-60"
      >
        {busy ? 'Removing…' : `Remove anyway`}
      </button>
    </>
  ) : (
    <>
      <label className="mr-auto flex items-center gap-2 text-[13px] text-fg-muted" title="Only a branch whose every commit is in the default branch">
        <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={deleteBranches} onChange={(e) => setDeleteBranches(e.target.checked)} />
        Also delete merged branches
      </label>
      <SheetButton onClick={onClose}>Close</SheetButton>
      <button
        type="button"
        disabled={busy || chosen.length === 0}
        onClick={() => void remove()}
        className="inline-flex h-[34px] items-center rounded-[7px] bg-danger px-4 text-[14px] font-semibold text-panel hover:brightness-110 disabled:opacity-50"
      >
        {busy ? 'Removing…' : chosen.length === 0 ? 'Remove' : `Remove ${chosen.length}${chosenSize > 0 ? ` · ${fmtBytes(chosenSize)}` : ''}`}
      </button>
    </>
  )

  return (
    <Sheet title={`Copies of ${name}`} label={`Copies of ${name}`} width={760} onClose={onClose} footer={footer}>
      <div className="grid gap-3 px-5 py-4">
        {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
        {!view && !error && <p className="text-[13px] text-fg-muted">Asking git…</p>}
        {view && (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-fg-muted">
            <span>
              <span className="font-medium text-fg">{linked.length === 1 ? '1 copy' : `${linked.length} copies`}</span>
              {linked.length > 0 && <> · <span className="num text-fg" aria-live="polite">{totalText}</span> on disk</>}
            </span>
            {view.pending && <span className="text-fg-faint">measuring…</span>}
            {!confirming && safe.length > 0 && (
              <button
                type="button"
                className="ml-auto text-[12.5px] text-accent hover:underline"
                onClick={() => { setResults(null); setPicked(new Set(safe.map((c) => c.path))) }}
              >
                Select merged and clean ({safe.length})
              </button>
            )}
          </div>
        )}
        {results && <Results results={results} />}
        {confirming ? (
          <Confirm risky={risky} hasRemote={hasRemote} others={chosen.length - risky.length} label={label} />
        ) : (
          view && (
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-px overflow-hidden rounded-[8px] border border-[var(--app-hairline)]" aria-label="Copies">
              {view.copies.map((c) => (
                <Row key={c.path} c={c} label={label(c)} where={shortPath(c.path, view.copies[0]?.main ? view.copies[0].path : '')} hasRemote={hasRemote} defaultBranch={view.default_branch} picked={picked.has(c.path)} onToggle={() => toggle(c.path)} />
              ))}
            </ul>
          )
        )}
        {!confirming && history.length > 0 && (
          <RecentlyRemoved history={history} restoring={restoring} onRestore={(r) => void restore(r)} />
        )}
        {!confirming && view && (
          <p className="text-[12px] leading-snug text-fg-faint">
            Only copies Caprock made are removed here, never the main checkout. Removing deletes the folder, including ignored files such as
            dependencies; the branch stays unless it is merged and you ask for it to go.
          </p>
        )}
      </div>
    </Sheet>
  )
}

function Row({ c, label, where, hasRemote, defaultBranch, picked, onToggle }: {
  c: ProjectCopy
  label: string
  /** The path to show: relative to the main checkout when inside it. */
  where: string
  hasRemote: boolean
  defaultBranch?: string
  picked: boolean
  onToggle: () => void
}) {
  const blocked = blockedReason(c)
  const id = `copy-${c.path}`
  return (
    <li className={`flex min-w-0 items-center gap-3 bg-panel px-3 py-2 ${blocked ? '' : 'hover:bg-[var(--app-row-hover)]'}`} title={blocked ?? undefined}>
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4 shrink-0 accent-[var(--color-accent)] disabled:opacity-30"
        checked={picked}
        disabled={!!blocked}
        onChange={onToggle}
        aria-describedby={blocked ? `${id}-why` : undefined}
      />
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[13px] text-fg">{label}</span>
          <Badges c={c} hasRemote={hasRemote} defaultBranch={defaultBranch} />
        </span>
        <span className="block truncate font-mono text-[11.5px] text-fg-faint" title={c.path}>{where}</span>
        {blocked && !c.main && <span id={`${id}-why`} className="block truncate text-[11.5px] text-fg-muted">{blocked}</span>}
        {c.main && <span id={`${id}-why`} className="sr-only">{blocked}</span>}
      </label>
      <span className="w-[72px] shrink-0 text-right text-[12px] text-fg-muted" title={c.committed_at ? new Date(c.committed_at * 1000).toLocaleString() : undefined}>
        {c.committed_at ? fmtAgo(c.committed_at * 1000) : '—'}
      </span>
      <span className="num w-[76px] shrink-0 text-right text-[12.5px] text-fg" title={c.size_capped ? 'Stopped counting at its limit; at least this much' : undefined}>
        {sizeText(c)}
      </span>
    </li>
  )
}

function Badge({ tone, title, children }: { tone: 'ok' | 'warn' | 'accent' | 'muted' | 'danger'; title?: string; children: React.ReactNode }) {
  const cls = {
    ok: 'border-ok/40 text-ok',
    warn: 'border-warn/50 text-warn',
    accent: 'border-accent/50 text-accent',
    muted: 'border-[var(--app-hairline-strong)] text-fg-muted',
    danger: 'border-danger/50 text-danger',
  }[tone]
  return <span title={title} className={`shrink-0 whitespace-nowrap rounded-full border px-1.5 py-px text-[10.5px] font-medium leading-[15px] ${cls}`}>{children}</span>
}

function Badges({ c, hasRemote, defaultBranch }: { c: ProjectCopy; hasRemote: boolean; defaultBranch?: string }) {
  const out: React.ReactNode[] = []
  if (c.main) out.push(<Badge key="main" tone="muted">main checkout</Badge>)
  else if (!c.caprock) out.push(<Badge key="hand" tone="muted" title="Made outside Caprock">yours</Badge>)
  if (c.missing) out.push(<Badge key="missing" tone="warn" title="Its folder is gone; removing tidies git's record of it">folder missing</Badge>)
  if (c.locked) out.push(<Badge key="locked" tone="muted">locked</Badge>)
  if (c.live.length > 0) out.push(<Badge key="live" tone="accent" title={c.live.join(', ')}>live</Badge>)
  if (c.dirty) out.push(<Badge key="dirty" tone="warn" title="Uncommitted changes, untracked files included">{c.changed === 1 ? '1 change' : `${c.changed} changes`}</Badge>)
  if (c.stale) out.push(<Badge key="stale" tone="muted" title="No commit for 14 days and no pull request: worth a look; never removed for this">stale</Badge>)
  if (!c.main && c.merged) out.push(<Badge key="merged" tone="ok" title={`Every commit on it is in ${defaultBranch || 'the default branch'}`}>merged</Badge>)
  if (hasRemote && !c.missing && !c.detached) {
    if (c.unpushed > 0) out.push(<Badge key="unpushed" tone="warn" title="Commits no remote has">{c.unpushed} unpushed</Badge>)
    else if (!c.main) out.push(<Badge key="pushed" tone="ok" title="Every commit is on a remote">pushed</Badge>)
  }
  if ((c.orphaned ?? 0) > 0) out.push(<Badge key="orphan" tone="danger" title="Commits on a detached HEAD that no branch holds">{c.orphaned} on no branch</Badge>)
  if (c.error) out.push(<Badge key="err" tone="danger" title={c.error}>git error</Badge>)
  return <>{out}</>
}

function Confirm({ risky, hasRemote, others, label }: { risky: ProjectCopy[]; hasRemote: boolean; others: number; label: (c: ProjectCopy) => string }) {
  return (
    <div role="group" aria-label="Confirm what would be lost" className="grid gap-2 rounded-[8px] border border-danger/40 bg-danger/5 px-4 py-3">
      <p className="text-[13px] font-medium text-fg">
        {risky.length === 1 ? 'This copy has work that is not saved anywhere else:' : `These ${risky.length} copies have work that is not saved anywhere else:`}
      </p>
      <ul className="grid gap-1.5">
        {risky.map((c) => (
          <li key={c.path} className="text-[12.5px] leading-snug">
            <span className="font-mono text-fg">{label(c)}</span>
            <ul className="ml-4 list-disc text-fg-muted">
              {lossOf(c, hasRemote).map((l) => <li key={l}>{l}</li>)}
            </ul>
          </li>
        ))}
      </ul>
      {others > 0 && <p className="text-[12px] text-fg-muted">{others === 1 ? 'The other copy loses nothing.' : `The other ${others} lose nothing.`}</p>}
    </div>
  )
}

function Results({ results }: { results: { removed: CopyRemoved[]; failed: CopyRemoved[]; freed: number } }) {
  const branches = results.removed.map((r) => r.branch_deleted).filter(Boolean)
  return (
    <div role="status" className="grid gap-1 text-[12.5px]">
      {results.removed.length > 0 && (
        <p className="text-ok">
          Removed {results.removed.length === 1 ? '1 copy' : `${results.removed.length} copies`}
          {results.freed > 0 ? `, ${fmtBytes(results.freed)} freed` : ''}
          {branches.length > 0 ? `; deleted ${branches.length === 1 ? 'branch' : 'branches'} ${branches.join(', ')}` : ''}.
        </p>
      )}
      {results.failed.map((r) => (
        <p key={r.path} className="text-danger">
          <span className="font-mono">{r.path.split(/[\\/]/).pop()}</span>: {r.error}
        </p>
      ))}
    </div>
  )
}

/** What was removed — here or by the cleanup — when, how much it freed, and Restore while the branch is kept. */
function RecentlyRemoved({ history, restoring, onRestore }: { history: CleanupRecord[]; restoring: string; onRestore: (r: CleanupRecord) => void }) {
  const how = { auto: 'automatically', ask: 'from the cleanup line', manual: 'here' } as const
  return (
    <section aria-label="Recently removed" className="grid gap-1.5" data-copies-history>
      <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-fg-faint">Recently removed</h3>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-px overflow-hidden rounded-[8px] border border-[var(--app-hairline)]">
        {history.map((r) => (
          <li key={r.id} className="flex min-w-0 items-center gap-3 bg-panel px-3 py-1.5 text-[12.5px]">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-mono text-fg">{r.branch || baseOf(r.path)}</span>
              <span className="text-fg-faint"> · {fmtAgo(r.at)} · {how[r.how] ?? r.how}</span>
            </span>
            <span className="num w-[112px] shrink-0 whitespace-nowrap text-right text-fg-muted">{r.bytes > 0 ? `${fmtBytes(r.bytes)} freed` : '—'}</span>
            <span className="w-[72px] shrink-0 text-right">
              {r.restored_at ? (
                <span className="text-fg-faint">restored</span>
              ) : r.restorable ? (
                <button type="button" className="text-accent hover:underline disabled:opacity-60" disabled={!!restoring} onClick={() => onRestore(r)}>
                  {restoring === r.id ? 'Restoring…' : 'Restore'}
                </button>
              ) : (
                <span className="text-fg-faint" title="Removed more than 7 days ago, or its folder is in use again">—</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
