/**
 * What your next session gets (#/brain): the memories a new session in a
 * repository is handed with its handoff, as GET /v1/brain/handoff names them
 * — picked by the code the SessionStart handoff runs (store.BrainHandoff):
 * pinned first, then newest, up to five in a budget of 700 characters. The
 * owner, 2026-10-16 (translated): "it's unclear what to do with it" — this
 * is what it is for, so the screen leads with it.
 *
 * Under the list it says whether a session opening there now would be handed
 * them at all — Memory between sessions on, and a passage left in the last
 * 14 days, which is what carries them — the share held back at random to
 * measure it, and how many sessions were handed memories (the status's
 * `handoff`). Nothing here is estimated.
 */
import { useEffect, useState } from 'react'
import { api, type BrainHandoff, type BrainHandoffView, type BrainNode } from '@/lib/api'
import { KIND_COLOR, KIND_LABEL, useBrainFrames } from '@/lib/brain'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The project to open on: the one with the newest memory, else the one with the most. */
export function defaultProject(memories: BrainNode[], projects: { project: string; count: number }[]): string {
  let best = ''
  let at = -1
  for (const n of memories) {
    if (n.source.project && n.created_at > at) { best = n.source.project; at = n.created_at }
  }
  return best || projects[0]?.project || ''
}

function useHandoff(project: string): BrainHandoffView | null | 'error' {
  const [v, setV] = useState<BrainHandoffView | null | 'error'>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!project) return
    let live = true
    api.brainHandoff(project).then((r) => { if (live) setV(r) }, () => { if (live) setV('error') })
    return () => { live = false }
  }, [project, tick])
  // A pin, an edit, a delete or a new memory can change the pick.
  useBrainFrames(() => setTick((t) => t + 1))
  return v
}

export function BrainNext({ projects, initial, selected, onSelect, handoff }: {
  projects: { project: string; count: number }[]
  /** The project to open on (defaultProject). */
  initial: string
  selected?: number
  onSelect: (id: number) => void
  /** The status's count of sessions handed memories. */
  handoff?: BrainHandoff
}) {
  const now = useNow(60_000)
  const [project, setProject] = useState(initial)
  useEffect(() => { if (!project && initial) setProject(initial) }, [initial, project])
  const v = useHandoff(project)
  const view = v && v !== 'error' && v.project === project ? v : null
  const served = view?.served
  const off = served && !served.on
  return (
    <section className="grid min-w-0 grid-cols-1 gap-2.5 rounded-[12px] border border-border bg-panel px-4 py-3.5" aria-labelledby="brain-next-title" data-brain-next>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 id="brain-next-title" className="text-[16px] font-semibold text-fg">What your next session gets</h2>
        <label className="ml-auto flex min-w-0 items-center gap-2 text-[12.5px] text-fg-muted">
          <span className="shrink-0">A new session in</span>
          <select className="input !h-[28px] !w-auto min-w-0 max-w-[220px] !py-0 text-[13px]" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Repository" data-brain-next-project>
            {!projects.some((p) => p.project === project) && project && <option value={project}>{project}</option>}
            {projects.map((p) => <option key={p.project} value={p.project}>{p.project}</option>)}
          </select>
        </label>
      </div>
      <p className="text-[12.5px] leading-snug text-fg-muted">
        Handed to it at the start, with where the last session there left off — up to {view?.max ?? 5} memories, pinned first, then the newest that fit.
      </p>

      {v === 'error' && <p className="text-[13px] text-fg-muted">Could not read what a new session would get.</p>}
      {!view && v !== 'error' && <div className="h-[84px] animate-pulse rounded-[8px] bg-panel-2 motion-reduce:animate-none" aria-hidden />}
      {view && view.memories.length === 0 && (
        <p className="rounded-[8px] border border-dashed border-border px-3 py-3 text-[13px] text-fg-muted" data-brain-next-empty>
          Nothing kept for {project} yet, so a new session there is handed no memories.
        </p>
      )}
      {view && view.memories.length > 0 && (
        <ol className={`grid min-w-0 grid-cols-1 gap-1 ${off ? 'opacity-60' : ''}`} aria-label={`What a new session in ${project} gets`}>
          {view.memories.map((n, i) => (
            <li key={n.id}>
              <button type="button" onClick={() => onSelect(n.id)} data-brain-next-row={n.id} aria-current={selected === n.id ? 'true' : undefined}
                className={`grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-baseline gap-x-2 rounded-[8px] border px-3 py-2 text-left ${
                  selected === n.id ? 'border-accent/50 bg-accent/[0.06]' : 'border-transparent bg-panel-2/60 hover:border-border-strong'}`}>
                <span className="num text-[12px] text-fg-faint" aria-hidden>{i + 1}</span>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span aria-hidden className="inline-block h-[7px] w-[7px] shrink-0 translate-y-[-1px] rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
                    <span className="shrink-0 text-[11.5px] text-fg-muted">{KIND_LABEL[n.kind]}</span>
                    <span className="min-w-0 truncate text-[13.5px] font-medium text-fg">{n.title}</span>
                  </span>
                  {n.summary && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-fg-muted">{n.summary}</span>}
                </span>
                <span className="shrink-0 text-[11.5px] text-fg-muted">{n.pinned ? <span className="text-accent">Pinned</span> : fmtAgo(n.created_at, now)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {view && (
        <p className="text-[12.5px] leading-snug text-fg-muted" data-brain-gives>
          {off
            ? 'Memory between sessions is off in Settings, so a new session is handed none of these until it is on.'
            : served && !served.left_off_at
              ? `No session in ${project} left a passage to hand over in the last 14 days, and these ride with that passage — so nothing goes until one does.`
              : served?.left_off_at
                ? `A session opening there now gets these, with the passage from ${fmtAgo(served.left_off_at, now)}.`
                : ''}
          {served && served.on && served.holdout_pct > 0 && ` ${served.holdout_pct}% of new sessions are held back at random, to measure whether it helps.`}
          {handoff && handoff.on && (handoff.sessions > 0
            ? ` ${plural(handoff.sessions_24h, 'session', 'sessions')} got ${plural(handoff.memories_24h, 'memory', 'memories')} in the last 24 h, ${handoff.sessions} in all.`
            : ' None has been handed any yet.')}
        </p>
      )}
    </section>
  )
}
