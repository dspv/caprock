/**
 * The graph as a card, and the graph opened (#/brain). The owner, 2026-10-16
 * (translated): "I'd put the ball just as an element, not the centre — it's
 * just a visualisation. Want to open it — it opens in a modal, rotate and
 * explore there." And 2026-10-17 (translated): "I'm missing that Second
 * Brain unfolds and there is a beautiful graph with useful info."
 *
 * - **The card** — a square of the dot disc (BrainGraphCanvas `mini`: no
 *   labels, no pan or zoom), coloured by project, a caption with what it
 *   holds, and *Open the graph*. The whole card is one button. While the
 *   first memories are still being found it is the living brain (BrainOrb).
 * - **The unfold** — the card opens into the graph: the dialog is laid out
 *   at its full size at once and revealed from the card's rectangle outward
 *   (a clip-path, so nothing inside is squashed), the card's picture growing
 *   from where it was to the middle of the graph and fading as the full
 *   graph fades in; closing folds it back into the card. On a phone the
 *   dialog is a full-screen sheet. Under prefers-reduced-motion it is a cut.
 * - **The graph opened** — the interactive graph coloured by project, with a
 *   search and a project picker that pick nodes out (the rest fade; nothing
 *   is laid out again), and beside it (under it on a phone) the panel
 *   (BrainGraphPanel): what the hovered or opened node holds, else the whole
 *   graph's counts, its projects and its newest memories.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { BrainAutoStatus, BrainGraph } from '@/lib/api'
import { brainActivity, isEntity, useBrainLanded } from '@/lib/brain'
import { indexGraph, pickNodes } from '@/lib/brainview'
import { useNow } from '@/lib/useNow'
import { BrainGraphCanvas } from '@/components/BrainGraphCanvas'
import { BrainOrb } from '@/components/BrainOrb'
import { useAgentsUsed } from '@/components/BrainAgents'
import { CloseButton, DialogBackdrop } from '@/components/Dialog'
import { BrainGraphPanel } from './BrainGraphPanel'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** How long the card takes to unfold into the graph, and to fold back. */
const UNFOLD_MS = 480
const FOLD_MS = 300
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** What a graph holds, in words: *278 memories · 91 topics*. */
export function graphCaption(g: BrainGraph): string {
  const topics = g.nodes.filter((n) => n.kind === 'topic').length
  return `${g.nodes.some((n) => n.kind === 'note') ? g.total === 1 ? '1 note' : `${g.total} memories and notes` : plural(g.total, 'memory', 'memories')} · ${plural(topics, 'topic', 'topics')}`
}

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** Where the card was when it was opened: its box and its picture, for the unfold. */
export interface UnfoldFrom { rect: DOMRect; picture?: DOMRect; image?: string }

export function BrainGraphCard({ graph, auto, kept, onOpen, open = false }: {
  graph: BrainGraph | null
  auto?: BrainAutoStatus
  /** Memories kept; none yet, it is the living brain. */
  kept: number
  onOpen: (from: UnfoldFrom) => void
  /** The graph is open: the card keeps its place, empty, as the fold's target. */
  open?: boolean
}) {
  const agents = useAgentsUsed()
  const landed = useBrainLanded()
  const button = useRef<HTMLButtonElement>(null)
  const memories = graph?.nodes.filter((n) => !isEntity(n.kind)).length ?? 0
  const drawable = !!graph && memories > 0
  const idx = useMemo(() => (graph && drawable ? indexGraph(graph) : null), [graph, drawable])
  let body: ReactNode
  if (drawable) {
    body = (
      <span className="pointer-events-none absolute inset-0 block" data-brain-card-picture>
        <BrainGraphCanvas graph={graph} mini tint={idx?.colorOf} className="h-full w-full" ariaLabel={`Second Brain graph: ${graphCaption(graph)}`} />
      </span>
    )
  } else {
    body = <BrainOrb kinds={(graph?.nodes ?? []).map((n) => n.kind)} count={kept} agents={agents} activity={brainActivity(auto)} landed={landed} className="absolute inset-0" ariaLabel="Second Brain being built" />
  }
  const caption = graph && drawable ? graphCaption(graph) : 'Memories land here as they are found'
  if (!drawable) {
    return (
      <div className="grid gap-2 rounded-[12px] border border-border bg-panel p-2.5" data-brain-graph-card="waiting">
        <div className="relative aspect-square w-full overflow-hidden rounded-[9px]" data-brain-live-orb>{body}</div>
        <p className="px-0.5 text-[12.5px] text-fg-muted" data-brain-graph-waiting>{caption}.</p>
      </div>
    )
  }
  const unfold = () => {
    const el = button.current
    if (!el) return
    const pic = el.querySelector<HTMLElement>('[data-brain-card-picture]')
    let image: string | undefined
    try { image = pic?.querySelector('canvas')?.toDataURL('image/png') } catch { /* a canvas the browser will not read: no picture */ }
    onOpen({ rect: el.getBoundingClientRect(), picture: pic?.getBoundingClientRect(), image })
  }
  return (
    <button ref={button} type="button" onClick={unfold} data-brain-graph-card="ready" aria-label={`Open the graph — ${caption}`} aria-expanded={open}
      className={`group grid w-full gap-2 rounded-[12px] border border-border bg-panel p-2.5 text-left transition-[border-color,box-shadow,opacity] hover:border-border-strong hover:shadow-[0_2px_10px_rgba(0,0,0,0.08)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/60 motion-reduce:transition-none ${open ? 'opacity-40' : ''}`}>
      <span className="relative block aspect-square w-full overflow-hidden rounded-[9px] bg-panel">{body}</span>
      <span className="flex items-center gap-2 px-0.5">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-muted" data-brain-graph-caption>{caption}</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-fg group-hover:text-accent">
          <svg aria-hidden viewBox="0 0 16 16" className="h-[12px] w-[12px]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
          </svg>
          Open the graph
        </span>
      </span>
    </button>
  )
}

/** The inset, from the dialog's box, that shows only `r`: the clip-path the unfold starts from. */
function insetOf(r: DOMRect, box: DOMRect, round: number): string {
  const t = Math.max(0, r.top - box.top)
  const l = Math.max(0, r.left - box.left)
  const b = Math.max(0, box.bottom - r.bottom)
  const rt = Math.max(0, box.right - r.right)
  return `inset(${t}px ${rt}px ${b}px ${l}px round ${round}px)`
}

export function BrainGraphDialog({ graph, selected, onSelect, onClose, editable, from, cardEl, onOpenProject, onOpenTopic }: {
  graph: BrainGraph
  selected?: number
  onSelect: (id: number | undefined) => void
  onClose: () => void
  editable: boolean
  /** The card it unfolds from; none, it simply appears. */
  from?: UnfoldFrom
  /** The card, found again on the way out, to fold back into. */
  cardEl?: () => HTMLElement | null
  /** *Open* on a project: its memories on the screen. */
  onOpenProject?: (name: string) => void
  /** *Open* on a topic: searched on the screen. */
  onOpenTopic?: (title: string) => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const ghost = useRef<HTMLImageElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const closing = useRef(false)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [hovered, setHovered] = useState<number | undefined>()
  const now = useNow(60_000)
  const idx = useMemo(() => indexGraph(graph), [graph])
  const picked = useMemo(() => pickNodes(graph, idx, query, project), [graph, idx, query, project])
  const pickedMemories = useMemo(() => (picked ? [...picked].filter((id) => !isEntity(idx.byId.get(id)!.kind)).length : 0), [picked, idx])
  // The panel follows the pointer, but holds a moment after it leaves a dot,
  // so crossing the gap between two dots does not flash the overview.
  const hold = useRef(0)
  const onHover = (id: number | undefined) => {
    window.clearTimeout(hold.current)
    if (id !== undefined) setHovered(id)
    else hold.current = window.setTimeout(() => setHovered(undefined), 450)
  }
  useEffect(() => () => window.clearTimeout(hold.current), [])

  // The unfold: laid out at full size, revealed from the card's box outward.
  useLayoutEffect(() => {
    const p = panel.current
    const bd = panel.current?.parentElement
    if (!p || !bd || !from || reducedMotion() || typeof p.animate !== 'function') return
    const box = p.getBoundingClientRect()
    const anims: Animation[] = []
    anims.push(p.animate([{ clipPath: insetOf(from.rect, box, 12) }, { clipPath: 'inset(0px 0px 0px 0px round 14px)' }], { duration: UNFOLD_MS, easing: EASE }))
    anims.push(bd.animate([{ backgroundColor: 'rgba(0,0,0,0)' }, { backgroundColor: 'rgba(0,0,0,0.45)' }], { duration: UNFOLD_MS, easing: 'ease-out' }))
    for (const el of p.querySelectorAll<HTMLElement>('[data-unfold-fade]')) {
      anims.push(el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: UNFOLD_MS * 0.45, easing: 'ease-out', fill: 'backwards' }))
    }
    // The card's picture grows from where it was to the middle of the graph,
    // and gives way to the graph itself.
    const g = ghost.current
    const a = area.current?.getBoundingClientRect()
    if (g && a && from.picture && from.image) {
      const side = Math.min(a.width, a.height) * 0.86
      const tx = a.left + (a.width - side) / 2
      const ty = a.top + (a.height - side) / 2
      const s = side / from.picture.width
      Object.assign(g.style, { left: `${from.picture.left}px`, top: `${from.picture.top}px`, width: `${from.picture.width}px`, height: `${from.picture.height}px`, display: 'block' })
      const ga = g.animate([
        { transform: 'none', opacity: 1 },
        { transform: `translate(${tx - from.picture.left}px, ${ty - from.picture.top}px) scale(${s})`, opacity: 0.9, offset: 0.75 },
        { transform: `translate(${tx - from.picture.left}px, ${ty - from.picture.top}px) scale(${s})`, opacity: 0 },
      ], { duration: UNFOLD_MS + 260, easing: EASE, fill: 'forwards' })
      ga.onfinish = () => { g.style.display = 'none' }
      anims.push(ga)
    }
    return () => { for (const x of anims) x.cancel() }
  }, [from])

  // Focus moves into the dialog, and back to what opened it on the way out.
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLElement>('[data-brain-graph="full"]')?.focus({ preventScroll: true })
    return () => back?.focus?.({ preventScroll: true })
  }, [])

  // Folding back into the card, when it is still on screen; else a short fade.
  const close = () => {
    if (closing.current) return
    const p = panel.current
    const bd = panel.current?.parentElement
    if (!p || !bd || reducedMotion() || typeof p.animate !== 'function') { onClose(); return }
    closing.current = true
    const box = p.getBoundingClientRect()
    const card = cardEl?.()?.getBoundingClientRect()
    const seen = card && card.width > 0 && card.bottom > 0 && card.top < window.innerHeight
    const a = seen
      ? p.animate([{ clipPath: 'inset(0px 0px 0px 0px round 14px)' }, { clipPath: insetOf(card, box, 12) }], { duration: FOLD_MS, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' })
      : p.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.98)' }], { duration: 180, easing: 'ease-in', fill: 'forwards' })
    bd.animate([{ backgroundColor: 'rgba(0,0,0,0.45)' }, { backgroundColor: 'rgba(0,0,0,0)' }], { duration: seen ? FOLD_MS : 180, fill: 'forwards' })
    a.onfinish = () => onClose()
  }
  // Escape lets go of a graph in hand first, as on the screen; the next one closes.
  const escape = () => {
    const held = panel.current?.querySelector<HTMLElement>('[data-brain-active="true"]')
    if (held && held.contains(document.activeElement)) { held.blur(); return }
    close()
  }
  const focus = hovered ?? selected
  const filtered = !!picked
  return (
    <DialogBackdrop onClose={escape} className="fixed inset-0 z-50 grid place-items-stretch bg-black/45 sm:p-5" data-brain-graph-backdrop>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="Second Brain graph" data-brain-graph-dialog
        className="relative flex min-h-0 min-w-0 flex-col overflow-hidden border-border bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.3)] max-sm:h-[100dvh] sm:rounded-[14px] sm:border">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3.5 py-2" data-unfold-fade>
          <h2 className="text-[14px] font-semibold text-fg">Second Brain graph</h2>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-muted" data-brain-graph-dialog-caption>
            {filtered ? `${plural(pickedMemories, 'memory', 'memories')} picked out of ${idx.memories}` : graphCaption(graph)}
          </span>
          <span className="flex items-center gap-1.5 max-sm:order-last max-sm:w-full sm:shrink-0">
            <input className="input h-[30px] min-w-0 flex-1 text-[12.5px] sm:!w-[220px] sm:flex-none" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Find in the graph" aria-label="Find in the graph" data-brain-graph-search />
            <select className="input !w-auto h-[30px] max-w-[160px] text-[12.5px]" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Pick out a project" data-brain-graph-project>
              <option value="">Every project</option>
              {idx.projects.map((p) => <option key={p.name} value={p.name}>{p.name} · {p.memories}</option>)}
            </select>
          </span>
          {graph.nodes.some((n) => n.kind === 'note') && <span className="text-[11.5px] text-fg-muted">◆ Obsidian note</span>}
          <CloseButton onClick={close} label="Close the graph" />
        </div>
        <div className="flex min-h-0 flex-1 gap-3 p-3 max-md:flex-col max-md:p-2">
          <div ref={area} className="relative flex min-h-0 min-w-0 flex-1 flex-col max-md:min-h-[52%]">
            <BrainGraphCanvas graph={graph} selected={selected} onSelect={onSelect} tint={idx.colorOf} highlight={picked} onHover={onHover} restLabels
              className="min-h-0 flex-1 rounded-[10px] border border-border bg-panel" />
            {filtered && pickedMemories === 0 && (
              <p className="pointer-events-none absolute inset-x-0 top-3 text-center text-[12.5px] text-fg-muted" data-brain-graph-none>Nothing here matches.</p>
            )}
          </div>
          <div className="flex min-h-0 w-full flex-col md:w-[320px] md:shrink-0 max-md:max-h-[46%]" data-unfold-fade>
            <BrainGraphPanel graph={graph} idx={idx} focus={focus} selected={selected} project={project} now={now}
              onSelect={(id) => { setHovered(undefined); onSelect(id) }} onProject={setProject}
              onOpenProject={(name) => { onOpenProject?.(name); close() }}
              onOpenTopic={(t) => { onOpenTopic?.(t); close() }}
              editable={editable} />
          </div>
        </div>
      </div>
      {from?.image && <img ref={ghost} alt="" aria-hidden src={from.image} className="pointer-events-none fixed z-[51] hidden origin-top-left" data-brain-unfold-ghost />}
    </DialogBackdrop>
  )
}
