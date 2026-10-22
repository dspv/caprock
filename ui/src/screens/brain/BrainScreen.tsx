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
 * - **Building** and **With memories** — one layout, value first (owner,
 *   2026-10-16, translated: "it's unclear what to do with it … the ball just
 *   as an element, not the centre"):
 *   - one status line on top (BrainStrip), its details folded under it;
 *   - in the middle, **What your next session gets** (BrainNext): the
 *     memories a new session in a repository is handed, then **Recent
 *     memories** — search, a project, a span, the list;
 *   - on the side, the graph as a card (BrainGraphCard) that opens the
 *     interactive graph in a near-full-screen dialog, and the memory opened.
 *   At narrow widths the side column goes under the list.
 *   Before the first memory the middle says *Memories land here as they are
 *   found* and the card is the living brain.
 *
 * A memory opens on the side with its summary, the session it came from (a
 * link to the moment), what it is linked to, and the means to edit, pin or
 * delete it. Everything is read from and written to this machine's database.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isPairedDevice, type BrainNode } from '@/lib/api'
import { McpConnectRow } from '@/components/McpConnect'
import { BRAIN_TAGLINE, isBuilding, isEntity, KIND_COLOR, KIND_LABEL, openBrainCapture, useBrainGraph, useBrainStatus } from '@/lib/brain'
import { matchRanges } from '@/lib/brainsearch'
import { fmtAgo } from '@/lib/format'
import { keys } from '@/lib/appkeys'
import { isAppMode } from '@/lib/appmode'
import { useNow } from '@/lib/useNow'
import { Empty, Skeleton } from '@/components/ui'
import { BrainGlyph } from '@/components/BrainDrop'
import { ObsidianVaults } from './ObsidianVaults'
import { BrainDetail } from './BrainDetail'
import { BrainStart } from './BrainStart'
import { BrainStrip } from './BrainStrip'
import { BrainSettings } from './BrainSettings'
import { BrainNext, defaultProject } from './BrainNext'
import { BrainGraphCard, BrainGraphDialog, type UnfoldFrom } from './BrainGraphCard'

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

/** How many rows the list shows at first, and adds per *Show more*. */
const PAGE = 40

export function BrainScreen({ node }: { node?: number }) {
  const [vaultsOpen, setVaultsOpen] = useState(false)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [span, setSpan] = useState(0)
  const [selected, setSelected] = useState<number | undefined>(node)
  const [graphOpen, setGraphOpen] = useState(false)
  const [unfold, setUnfold] = useState<UnfoldFrom | undefined>()
  const cardBox = useRef<HTMLDivElement>(null)
  const recent = useRef<HTMLElement>(null)
  const [shown, setShown] = useState(PAGE)
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
  const filtered = !!(query || project || span)
  // The whole brain, for the card and the graph; a second read only while
  // the list is filtered.
  const whole = useBrainGraph({})
  const sel = useBrainGraph({ q: query, project, since }, 400, filtered)
  const graph = filtered ? sel.graph : whole.graph
  const error = filtered ? sel.error : whole.error
  useEffect(() => setShown(PAGE), [query, project, span])
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
  const auto = status?.auto
  const kept = (status?.memories ?? 0) + (status?.notes ?? 0)
  const phase: 'loading' | 'start' | 'building' | 'memories' = !status
    ? 'loading'
    : kept === 0 && !auto?.on ? 'start'
    : isBuilding(auto) || (auto?.on && kept === 0) ? 'building'
    : 'memories'
  const addNote = () => openBrainCapture()
  const initialProject = useMemo(
    () => defaultProject((whole.graph?.nodes ?? []).filter((n) => !isEntity(n.kind)), status?.projects ?? []),
    [whole.graph, status?.projects],
  )
  // *Open* on a project or a topic in the graph: the list, filtered to it, in view.
  const showRecent = () => window.setTimeout(() => recent.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }), 80)
  // On a narrow screen the memory opens under the list: bring it into view.
  const side = useRef<HTMLDivElement>(null)
  const select = (id: number | undefined) => {
    setSelected(id)
    if (id !== undefined && window.matchMedia?.('(max-width: 1023px)').matches) {
      window.setTimeout(() => side.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }), 50)
    }
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3" data-brain-screen data-brain-phase={phase}>
      <header className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-[-0.01em] text-fg">
            <BrainGlyph size={20} className="shrink-0 text-accent" /> Second Brain
          </h1>
          <p className="text-[13px] text-fg-muted" data-brain-tagline>{BRAIN_TAGLINE}</p>
        </div>
        {owner && <button type="button" onClick={() => setVaultsOpen(true)}
          className="h-[30px] rounded-[7px] border border-border px-2.5 text-[12.5px] text-fg-muted hover:text-fg">Import from Obsidian…</button>}
        {phase !== 'start' && phase !== 'loading' && owner && (
          <div className="flex items-center gap-2 pt-1">
            <button type="button" onClick={addNote} title={isAppMode() ? `Add a note (${keys('⇧⌘H')})` : undefined}
              className="h-[30px] rounded-[7px] px-2 text-[12.5px] text-fg-muted hover:bg-panel-2 hover:text-fg" data-brain-add-note>
              Add a note
            </button>
            {auto && <BrainSettings auto={auto} dbPath={status?.db_path} onChanged={reloadStatus} />}
          </div>
        )}
      </header>

      {owner && phase !== 'loading' && <McpConnectRow />}
      {vaultsOpen && <ObsidianVaults onClose={() => setVaultsOpen(false)} />}
      {phase === 'loading' && <Skeleton rows={5} className="rounded-[var(--radius-panel)] border border-border bg-panel" />}

      {phase === 'start' && <BrainStart auto={auto} owner={owner} onStarted={reloadStatus} onAddNote={addNote} />}

      {(phase === 'building' || phase === 'memories') && (
        <>
          {auto && (status?.notes && !auto.on
            ? <p className="text-[12.5px] text-fg-muted">Obsidian notes refresh automatically. Session extraction is off.</p>
            : <BrainStrip auto={auto} memories={status?.memories ?? 0} onChanged={reloadStatus} owner={owner} />)}

          <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]" data-brain-body>
            <main className="grid min-w-0 grid-cols-1 gap-4" aria-label="Second Brain">
              {kept === 0 ? (
                <div className="grid h-[160px] place-items-center rounded-[var(--radius-panel)] border border-dashed border-border px-4 text-center text-[14px] text-fg-muted" data-brain-list-waiting>
                  Memories land here as they are found.
                </div>
              ) : (
                <>
                  <BrainNext projects={status?.projects ?? []} initial={initialProject} selected={selected} onSelect={select} handoff={auto?.handoff} />

                  <section ref={recent} className="grid min-w-0 grid-cols-1 gap-2 scroll-mt-3" aria-labelledby="brain-recent-title" data-brain-recent-memories>
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <h2 id="brain-recent-title" className="text-[16px] font-semibold text-fg">{status?.notes ? 'Memories and notes' : 'Recent memories'}</h2>
                      {graph && (
                        <p className="text-[12px] text-fg-muted" data-brain-count>
                          {graph.total} {graph.total === 1 ? (memories[0]?.kind === 'note' ? 'note' : 'memory') : status?.notes ? 'memories and notes' : 'memories'}{filtered ? ' match' : ''}
                          {graph.total > memories.length ? ` · the ${query ? 'best' : 'newest'} ${memories.length} read` : ''}
                          {graph.close && <span data-brain-close> · including close matches</span>}
                          {!query && ' · pinned first'}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className="input min-w-[180px] max-w-[360px] flex-1"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="Search titles and summaries — typos are fine"
                        aria-label="Search memories"
                        title="Every word has to match a title, summary, project or topic, in any case or accent; a close spelling counts when little matches exactly."
                      />
                      <select className="input !w-auto max-w-[220px]" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
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
                    </div>

                    {error && !graph && <Empty title="Cannot read Second Brain">{error}</Empty>}
                    {!graph && !error && <Skeleton rows={5} className="rounded-[var(--radius-panel)] border border-border bg-panel" />}
                    {graph && memories.length === 0 && (
                      <Empty title="Nothing matches">Try a shorter phrase, another project or a longer span.</Empty>
                    )}
                    {graph && memories.length > 0 && (
                      <ul className="grid min-w-0 grid-cols-1 gap-1" aria-label="Memories">
                        {memories.slice(0, shown).map((n) => (
                          <li key={n.id}>
                            <button
                              type="button"
                              data-brain-row={n.id}
                              aria-current={selected === n.id ? 'true' : undefined}
                              onClick={() => select(n.id)}
                              className={`flex w-full items-baseline gap-2 rounded-[8px] border px-3 py-2 text-left ${
                                selected === n.id ? 'border-accent/50 bg-accent/[0.06]' : 'border-border bg-panel hover:border-border-strong'
                              }`}
                            >
                              <span aria-hidden className="inline-block h-[8px] w-[8px] shrink-0 translate-y-[-1px] rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
                              <span className="hidden w-[62px] shrink-0 text-[11.5px] text-fg-muted sm:inline">{n.vault ? 'Obsidian' : KIND_LABEL[n.kind]}</span>
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
                    {graph && memories.length > shown && (
                      <button type="button" onClick={() => setShown((v) => v + PAGE)} data-brain-more
                        className="justify-self-start rounded-[7px] border border-border px-2.5 py-1 text-[12.5px] text-fg-muted hover:border-border-strong hover:text-fg">
                        Show {Math.min(PAGE, memories.length - shown)} more
                      </button>
                    )}
                  </section>
                </>
              )}
            </main>

            <div ref={side} className="grid min-w-0 grid-cols-1 gap-3 lg:sticky lg:top-3" data-brain-side>
              {selected !== undefined && !graphOpen && (
                <BrainDetail key={selected} id={selected} onSelect={select} onClose={() => setSelected(undefined)} editable={owner} className="grid w-full !static max-h-none lg:max-h-[calc(100vh-7rem)]" />
              )}
              <div ref={cardBox} className={selected !== undefined && !graphOpen ? 'max-lg:hidden' : ''}>
                <BrainGraphCard graph={whole.graph} auto={auto} kept={kept} open={graphOpen} onOpen={(from) => { setUnfold(from); setGraphOpen(true) }} />
              </div>
            </div>
          </div>

          {graphOpen && whole.graph && (
            <BrainGraphDialog graph={whole.graph} selected={selected} onSelect={setSelected} onClose={() => setGraphOpen(false)} editable={owner}
              from={unfold} cardEl={() => cardBox.current?.querySelector<HTMLElement>('[data-brain-graph-card]') ?? null}
              onOpenProject={(name) => { setInput(''); setQuery(''); setProject(name); setSpan(0); showRecent() }}
              onOpenTopic={(title) => { setProject(''); setInput(title); setSpan(0); showRecent() }} />
          )}
        </>
      )}
    </div>
  )
}
