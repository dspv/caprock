/**
 * Second Brain (#/brain, ADR-063): what the sessions did, decided and found,
 * kept as memories linked to their projects and topics.
 *
 * Two views of the same read: the graph (memories and the topics and
 * projects they hang off, drawn by components/BrainGraphCanvas) and the
 * list. Search, a project and a time span narrow both; a memory opens on the right
 * with its summary, the session it came from (a link to the moment), what it
 * is linked to, and the means to edit, pin or delete it. Everything is read
 * from and written to this machine's database.
 */
import { useEffect, useMemo, useState } from 'react'
import { isPairedDevice, type BrainNode } from '@/lib/api'
import { BrainConsent } from '@/components/BrainAutoSetting'
import { isEntity, KIND_COLOR, KIND_LABEL, openBrainCapture, useBrainGraph, useBrainStatus } from '@/lib/brain'
import { fmtAgo } from '@/lib/format'
import { keys } from '@/lib/appkeys'
import { isAppMode } from '@/lib/appmode'
import { useNow } from '@/lib/useNow'
import { Empty, Skeleton } from '@/components/ui'
import { BrainGlyph } from '@/components/BrainDrop'
import { BrainGraphCanvas } from '@/components/BrainGraphCanvas'
import { BrainDetail } from './BrainDetail'

type View = 'graph' | 'list'
const VIEW_KEY = 'caprock-brain-view'

/** Graph or List, remembered in this browser; the graph first. */
function useView(): [View, (v: View) => void] {
  const [v, setV] = useState<View>(() => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'graph' } catch { return 'graph' } })
  return [v, (next) => { setV(next); try { localStorage.setItem(VIEW_KEY, next) } catch { /* private window */ } }]
}

/** The kinds' colours, so the graph's dots can be read. */
function Legend() {
  const kinds = ['decision', 'finding', 'idea', 'question', 'topic', 'project', 'person'] as const
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-0.5 pt-1.5 text-[11px] text-fg-faint" aria-hidden>
      {kinds.map((k) => (
        <span key={k} className="inline-flex items-center gap-1">
          <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: KIND_COLOR[k] }} />
          {KIND_LABEL[k]}
        </span>
      ))}
      <span className="ml-auto hidden sm:inline">Drag to move · scroll to zoom · double-click to fit</span>
    </div>
  )
}

/** The spans the time filter offers, in days; 0 is all of it. */
const SPANS: [number, string][] = [[0, 'All time'], [7, '7 days'], [30, '30 days'], [90, '90 days']]

export function BrainScreen({ node }: { node?: number }) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [span, setSpan] = useState(0)
  const [selected, setSelected] = useState<number | undefined>(node)
  const [view, setView] = useView()
  useEffect(() => { if (node) setSelected(node) }, [node])
  // A pause in typing, then the search: each one reads the graph.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(input.trim()), 200)
    return () => window.clearTimeout(t)
  }, [input])
  const now = useNow(60_000)
  // The span is counted from when the screen opened, so the request does not
  // change every minute with the clock.
  const [opened] = useState(() => Date.now())
  const since = span ? opened - span * 86_400_000 : 0
  const { graph, error } = useBrainGraph({ q: query, project, since })
  const { status, reload: reloadStatus } = useBrainStatus()
  const owner = !isPairedDevice()
  const memories = useMemo(() => (graph?.nodes ?? []).filter((n) => !isEntity(n.kind)), [graph])
  const topicsOf = useMemo(() => {
    const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n] as const))
    const m = new Map<number, BrainNode[]>()
    for (const e of graph?.edges ?? []) {
      const to = byId.get(e.to)
      if (!to || !isEntity(to.kind) || to.kind === 'project') continue
      const list = m.get(e.from) ?? []
      list.push(to)
      m.set(e.from, list)
    }
    return m
  }, [graph])
  const filtered = !!(query || project || span)

  return (
    <div className="grid gap-3" data-brain-screen>
      <p className="max-w-[760px] text-[13px] leading-relaxed text-fg-muted">
        <span className="text-fg">What your sessions decided, found and left open, kept as memories.</span>{' '}
        Drop any answer in from Memory or a chat, or add a line of your own
        {isAppMode() ? <> with <kbd className="app-kbd">{keys('⇧⌘H')}</kbd></> : ''}; each one links back to the moment it came
        from. Kept on this machine.
      </p>

      {/* Asked of everyone, once: Second Brain is free (owner decision, 2026-10-14). */}
      {owner && status?.auto && <BrainConsent auto={status.auto} onAnswer={reloadStatus} />}

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-[360px] flex-1"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search memories — a name, a decision…"
          aria-label="Search memories"
        />
        <select className="input !w-auto max-w-[260px]" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          <option value="">Every project</option>
          {(status?.projects ?? []).map((p) => <option key={p.project} value={p.project}>{p.project} · {p.count}</option>)}
        </select>
        <div role="radiogroup" aria-label="When" className="inline-flex h-[30px] items-center rounded-[7px] border border-border p-[2px]">
          {SPANS.map(([d, label]) => (
            <button key={d} type="button" role="radio" aria-checked={span === d} onClick={() => setSpan(d)}
              className={`h-full rounded-[5px] px-2 text-[12px] ${span === d ? 'bg-panel-2 font-medium text-fg' : 'text-fg-muted hover:text-fg'}`}>
              {label}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label="View" className="inline-flex h-[30px] items-center rounded-[7px] border border-border p-[2px]">
          {(['graph', 'list'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}
              className={`h-full rounded-[5px] px-2 text-[12px] ${view === v ? 'bg-panel-2 font-medium text-fg' : 'text-fg-muted hover:text-fg'}`}>
              {v === 'graph' ? 'Graph' : 'List'}
            </button>
          ))}
        </div>
        {owner && (
          <button type="button" onClick={() => openBrainCapture()}
            className="ml-auto inline-flex h-[30px] items-center gap-1.5 rounded-[7px] border border-accent/50 bg-accent/10 px-2.5 text-[12.5px] text-accent hover:bg-accent/20">
            <BrainGlyph size={13} /> Add to brain
          </button>
        )}
      </div>

      {error && !graph && <Empty title="Cannot read Second Brain">{error}</Empty>}
      {!graph && !error && <Skeleton rows={5} className="rounded-[var(--radius-panel)] border border-border bg-panel" />}

      {graph && (
        <div className="flex min-h-[420px] gap-3">
          <div className="min-w-0 flex-1">
            <p className="px-0.5 pb-1.5 text-[11px] text-fg-faint">
              {graph.total} {graph.total === 1 ? 'memory' : 'memories'}{filtered ? ' match' : ''}
              {graph.total > memories.length ? ` · the newest ${memories.length} shown` : ''}
            </p>
            {memories.length > 0 && view === 'graph' ? (
              <div data-brain-graph-view>
                <BrainGraphCanvas
                  graph={graph}
                  selected={selected}
                  onSelect={setSelected}
                  className="h-[max(420px,calc(100vh-280px))] rounded-[var(--radius-panel)] border border-border bg-panel"
                />
                <Legend />
              </div>
            ) : memories.length === 0 ? (
              <Empty title={filtered ? 'Nothing matches' : 'Nothing in your brain yet'}>
                {filtered
                  ? 'Try a shorter phrase, another project or a longer span.'
                  : 'Open Memory or a chat and press “Drop into brain” under an answer worth keeping, or add a line of your own.'}
              </Empty>
            ) : (
              <ul className="grid gap-1" aria-label="Memories">
                {memories.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      data-brain-row={n.id}
                      aria-current={selected === n.id ? 'true' : undefined}
                      onClick={() => setSelected(n.id)}
                      className={`flex w-full items-baseline gap-2 rounded-[8px] border px-3 py-2 text-left ${
                        selected === n.id ? 'border-accent/50 bg-accent/[0.06]' : 'border-border bg-panel hover:border-border-strong'
                      }`}
                    >
                      <span aria-hidden className="inline-block h-[8px] w-[8px] shrink-0 translate-y-[-1px] rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
                      <span className="w-[62px] shrink-0 text-[11px] text-fg-faint">{KIND_LABEL[n.kind]}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] text-fg">{n.pinned && <span className="mr-1 text-accent" title="Pinned">●</span>}{n.title}</span>
                        {(topicsOf.get(n.id)?.length ?? 0) > 0 && (
                          <span className="mt-0.5 block truncate text-[11px] text-fg-faint">{topicsOf.get(n.id)!.map((t) => t.title).join(' · ')}</span>
                        )}
                      </span>
                      {n.source.project && <span className="hidden max-w-[140px] shrink-0 truncate text-[11.5px] text-fg-muted sm:inline">{n.source.project}</span>}
                      <span className="num shrink-0 text-[11px] text-fg-faint">{fmtAgo(n.created_at, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {selected !== undefined && (
            <BrainDetail key={selected} id={selected} onSelect={setSelected} onClose={() => setSelected(undefined)} editable={owner} />
          )}
        </div>
      )}
    </div>
  )
}
