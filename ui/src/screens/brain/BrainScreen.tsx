/**
 * Second Brain (#/brain, ADR-063): what the sessions did, decided and found,
 * kept as memories linked to their projects and topics.
 *
 * Three states, one screen (owner, 2026-10-15, translated: "one click and
 * off we go … it must feel ACTIVE … minimal settings"):
 *
 * - **Not built** — off, nothing kept: BrainStart, one picture, *Free*, *Give
 *   your agents a memory* and one button, *Start building*, with the one line
 *   that says what it does and *Details*. No search, no filters, no
 *   instructions for an empty list; *Add a note* is a quiet link under it.
 * - **Building** — on, and reading or with sessions waiting (lib/brain
 *   isBuilding), or on with nothing kept yet: BrainLive, what it reads now,
 *   how far it is, the memories it found, today's tokens and where it all
 *   comes from — above the graph, which fills in as memories land (the
 *   canvas drops each new one in).
 * - **With memories** — the graph or the list, search, a project and a time
 *   span; one quiet line for the extraction (BrainLiveLine) and a gear,
 *   *Settings* (BrainSettings), for on/off, the model and the daily limit.
 *
 * A memory opens on the right with its summary, the session it came from (a
 * link to the moment), what it is linked to, and the means to edit, pin or
 * delete it. Everything is read from and written to this machine's database.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { isPairedDevice, type BrainNode } from '@/lib/api'
import { BRAIN_TAGLINE, isBuilding, isEntity, KIND_COLOR, KIND_LABEL, openBrainCapture, useBrainGraph, useBrainStatus } from '@/lib/brain'
import { matchRanges } from '@/lib/brainsearch'
import { fmtAgo } from '@/lib/format'
import { keys } from '@/lib/appkeys'
import { isAppMode } from '@/lib/appmode'
import { useNow } from '@/lib/useNow'
import { Empty, Skeleton } from '@/components/ui'
import { BrainGlyph } from '@/components/BrainDrop'
import { BrainGraphCanvas } from '@/components/BrainGraphCanvas'
import { BrainDetail } from './BrainDetail'
import { BrainStart } from './BrainStart'
import { BrainLive, BrainLiveLine } from './BrainLive'
import { BrainSettings } from './BrainSettings'

type View = 'graph' | 'list'
const VIEW_KEY = 'caprock-brain-view'

/** Graph or List, remembered in this browser; the graph first. */
function useView(): [View, (v: View) => void] {
  const [v, setV] = useState<View>(() => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'graph' } catch { return 'graph' } })
  return [v, (next) => { setV(next); try { localStorage.setItem(VIEW_KEY, next) } catch { /* private window */ } }]
}

/** The kinds' colours, so the graph's dots can be read. */
function Legend() {
  // As drawn (BrainGraphCanvas): dots in the text colour, a topic with a
  // faint cool tint, a project bigger and full strength.
  const items = [
    { label: 'Memory', size: 4, style: { background: 'var(--color-fg)', opacity: 0.85 } },
    { label: 'Topic', size: 6, style: { background: 'color-mix(in srgb, #7fa8e0 32%, var(--color-fg))', opacity: 0.86 } },
    { label: 'Project', size: 8, style: { background: 'var(--color-fg)' } },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 pt-1.5 text-[11.5px] text-fg-muted" aria-hidden data-brain-legend>
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block rounded-full" style={{ width: it.size, height: it.size, ...it.style }} />
          {it.label}
        </span>
      ))}
      <span className="ml-auto hidden sm:inline">Hover a dot to light its links · zoom in for names · drag to pan or move a dot</span>
    </div>
  )
}

/** Text with the search's terms marked where they occur, in any case or accent. */
function Marked({ text, terms }: { text: string; terms?: string[] }) {
  const ranges = useMemo(() => matchRanges(text, terms), [text, terms])
  if (ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let at = 0
  ranges.forEach(([a, b], i) => {
    if (a > at) parts.push(text.slice(at, a))
    parts.push(<mark key={i} data-match className="rounded-[3px] bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] text-fg">{text.slice(a, b)}</mark>)
    at = b
  })
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

/** The spans the time filter offers, in days; 0 is all of it. */
const SPANS: [number, string][] = [[0, 'All time'], [7, '7 days'], [30, '30 days'], [90, '90 days']]

const GRAPH_H = 'h-[max(420px,calc(100vh-340px))]'

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
  const auto = status?.auto
  const kept = status?.memories ?? 0
  const phase: 'loading' | 'start' | 'building' | 'memories' = !status
    ? 'loading'
    : kept === 0 && !auto?.on ? 'start'
    : isBuilding(auto) || (auto?.on && kept === 0) ? 'building'
    : 'memories'
  const addNote = () => openBrainCapture()

  return (
    <div className="grid gap-3" data-brain-screen data-brain-phase={phase}>
      <header className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-[-0.01em] text-fg">
            <BrainGlyph size={20} className="shrink-0 text-accent" /> Second Brain
          </h1>
          <p className="text-[13px] text-fg-muted" data-brain-tagline>{BRAIN_TAGLINE}</p>
        </div>
        {phase !== 'start' && phase !== 'loading' && owner && (
          <div className="flex items-center gap-2 pt-1">
            <button type="button" onClick={addNote} title={isAppMode() ? `Add a note (${keys('⇧⌘H')})` : undefined}
              className="h-[30px] rounded-[7px] px-2 text-[12.5px] text-fg-muted hover:bg-panel-2 hover:text-fg" data-brain-add-note>
              Add a note
            </button>
            {auto && <BrainSettings auto={auto} onChanged={reloadStatus} />}
          </div>
        )}
      </header>

      {phase === 'loading' && <Skeleton rows={5} className="rounded-[var(--radius-panel)] border border-border bg-panel" />}

      {phase === 'start' && <BrainStart auto={auto} owner={owner} onStarted={reloadStatus} onAddNote={addNote} />}

      {phase === 'building' && auto && <BrainLive auto={auto} onChanged={reloadStatus} kinds={memories.map((n) => n.kind)} count={kept} />}
      {phase === 'memories' && auto && <BrainLiveLine auto={auto} onChanged={reloadStatus} />}

      {phase === 'building' && kept === 0 && (
        <div className="grid h-[160px] place-items-center rounded-[var(--radius-panel)] border border-dashed border-border text-[14px] text-fg-muted" data-brain-graph-waiting>
          Memories land here as they are found.
        </div>
      )}

      {(phase === 'memories' || (phase === 'building' && kept > 0)) && (
        <>
          {phase === 'memories' && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input max-w-[360px] flex-1"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Search titles and summaries — typos are fine"
                aria-label="Search memories"
                title="Every word has to match a title, summary, project or topic, in any case or accent; a close spelling counts when little matches exactly."
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
            </div>
          )}

          {error && !graph && <Empty title="Cannot read Second Brain">{error}</Empty>}
          {!graph && !error && <Skeleton rows={5} className="rounded-[var(--radius-panel)] border border-border bg-panel" />}

          {graph && (
            <div className="flex min-h-[420px] gap-3">
              <div className="min-w-0 flex-1">
                <p className="px-0.5 pb-1.5 text-[12px] text-fg-muted">
                  {graph.total} {graph.total === 1 ? 'memory' : 'memories'}{filtered ? ' match' : ''}
                  {graph.total > memories.length ? ` · the ${query ? 'best' : 'newest'} ${memories.length} shown` : ''}
                  {graph.close && <span data-brain-close> · including close matches</span>}
                </p>
                {memories.length > 0 && (view === 'graph' || phase === 'building') ? (
                  <div data-brain-graph-view>
                    <BrainGraphCanvas
                      graph={graph}
                      selected={selected}
                      onSelect={setSelected}
                      className={`${GRAPH_H} rounded-[var(--radius-panel)] border border-border bg-panel`}
                    />
                    <Legend />
                  </div>
                ) : memories.length === 0 ? (
                  <Empty title="Nothing matches">Try a shorter phrase, another project or a longer span.</Empty>
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
                          <span className="w-[62px] shrink-0 text-[11.5px] text-fg-muted">{KIND_LABEL[n.kind]}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13.5px] text-fg">{n.pinned && <span className="mr-1 text-accent" title="Pinned">●</span>}<Marked text={n.title} terms={graph.terms} /></span>
                            {(topicsOf.get(n.id)?.length ?? 0) > 0 && (
                              <span className="mt-0.5 block truncate text-[11.5px] text-fg-muted"><Marked text={topicsOf.get(n.id)!.map((t) => t.title).join(' · ')} terms={graph.terms} /></span>
                            )}
                          </span>
                          {n.source.project && <span className="hidden max-w-[140px] shrink-0 truncate text-[11.5px] text-fg-muted sm:inline">{n.source.project}</span>}
                          <span className="num shrink-0 text-[11.5px] text-fg-muted">{fmtAgo(n.created_at, now)}</span>
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
        </>
      )}
    </div>
  )
}
