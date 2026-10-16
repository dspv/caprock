/**
 * The graph as a card, and the graph opened (#/brain). The owner, 2026-10-16
 * (translated): "I'd put the ball just as an element, not the centre — it's
 * just a visualisation. Want to open it — it opens in a modal, rotate and
 * explore there."
 *
 * - **The card** — a square of the dot disc (BrainGraphCanvas `mini`: no
 *   labels, no pan or zoom), a caption with what it holds, and *Open the
 *   graph*. Nothing in it reacts in place: the whole card is one button, a
 *   click or Enter opens the graph. While the first memories are still being
 *   found it is the living brain (BrainOrb) instead, sparks flying in.
 * - **The graph opened** — a near-full-screen dialog with the interactive
 *   graph as it was on the screen (click to take it in hand, then drag,
 *   scroll or pinch; a click on a dot opens it, its detail beside the graph),
 *   the legend, and the three ways out: ×, a click on the backdrop, Escape.
 *   Escape first lets go of a graph in hand, as it always has; the next
 *   closes the dialog.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { BrainAutoStatus, BrainGraph } from '@/lib/api'
import { brainActivity, isEntity, useBrainLanded } from '@/lib/brain'
import { BrainGraphCanvas } from '@/components/BrainGraphCanvas'
import { BrainOrb } from '@/components/BrainOrb'
import { useAgentsUsed } from '@/components/BrainAgents'
import { CloseButton, DialogBackdrop } from '@/components/Dialog'
import { BrainDetail } from './BrainDetail'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What a graph holds, in words: *278 memories · 91 topics*. */
export function graphCaption(g: BrainGraph): string {
  const topics = g.nodes.filter((n) => n.kind === 'topic').length
  return `${plural(g.total, 'memory', 'memories')} · ${plural(topics, 'topic', 'topics')}`
}

/** The kinds' dots, drawn as the graph draws them. */
export function Legend() {
  // As drawn (BrainGraphCanvas): dots in the text colour, a topic with a
  // faint cool tint, a project bigger and full strength.
  const items = [
    { label: 'Memory', size: 4, style: { background: 'var(--color-fg)', opacity: 0.85 } },
    { label: 'Topic', size: 6, style: { background: 'color-mix(in srgb, #7fa8e0 32%, var(--color-fg))', opacity: 0.86 } },
    { label: 'Project', size: 8, style: { background: 'var(--color-fg)' } },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-fg-muted" aria-hidden data-brain-legend>
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block rounded-full" style={{ width: it.size, height: it.size, ...it.style }} />
          {it.label}
        </span>
      ))}
      <span className="ml-auto hidden sm:inline">Click the graph to zoom and move it · hover a dot to light its links · zoom in for names</span>
    </div>
  )
}

export function BrainGraphCard({ graph, auto, kept, onOpen }: {
  graph: BrainGraph | null
  auto?: BrainAutoStatus
  /** Memories kept; none yet, it is the living brain. */
  kept: number
  onOpen: () => void
}) {
  const agents = useAgentsUsed()
  const landed = useBrainLanded()
  const memories = graph?.nodes.filter((n) => !isEntity(n.kind)).length ?? 0
  const drawable = !!graph && memories > 0
  let body: ReactNode
  if (drawable) {
    body = (
      <span className="pointer-events-none absolute inset-0 block">
        <BrainGraphCanvas graph={graph} mini className="h-full w-full" ariaLabel={`Second Brain graph: ${graphCaption(graph)}`} />
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
  return (
    <button type="button" onClick={onOpen} data-brain-graph-card="ready" aria-label={`Open the graph — ${caption}`}
      className="group grid w-full gap-2 rounded-[12px] border border-border bg-panel p-2.5 text-left transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-[0_2px_10px_rgba(0,0,0,0.08)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/60 motion-reduce:transition-none">
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

export function BrainGraphDialog({ graph, selected, onSelect, onClose, editable }: {
  graph: BrainGraph
  selected?: number
  onSelect: (id: number | undefined) => void
  onClose: () => void
  editable: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  // Focus moves into the dialog, and back to what opened it on the way out.
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLElement>('[data-brain-graph="full"]')?.focus({ preventScroll: true })
    return () => back?.focus?.({ preventScroll: true })
  }, [])
  // Escape lets go of a graph in hand first, as on the screen; the next one closes.
  const close = () => {
    const held = panel.current?.querySelector<HTMLElement>('[data-brain-active="true"]')
    if (held && held.contains(document.activeElement)) { held.blur(); return }
    onClose()
  }
  // A phone has no room beside the graph: a dot opens on the screen instead.
  const pick = (id: number) => {
    onSelect(id)
    if (window.matchMedia?.('(max-width: 767px)').matches) onClose()
  }
  return (
    <DialogBackdrop onClose={close} className="fixed inset-0 z-50 grid place-items-stretch bg-black/45 p-2 sm:p-5">
      <div ref={panel} role="dialog" aria-modal="true" aria-label="Second Brain graph" data-brain-graph-dialog
        className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[14px] border border-border bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.3)]">
        <div className="flex items-center gap-3 border-b border-border px-3.5 py-2">
          <h2 className="text-[14px] font-semibold text-fg">Second Brain graph</h2>
          <span className="min-w-0 truncate text-[12.5px] text-fg-muted">{graphCaption(graph)}</span>
          <span className="ml-auto" />
          <CloseButton onClick={onClose} label="Close the graph" />
        </div>
        <div className="flex min-h-0 flex-1 gap-3 p-3">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
            <BrainGraphCanvas graph={graph} selected={selected} onSelect={pick} className="min-h-0 flex-1 rounded-[10px] border border-border bg-panel" />
            <Legend />
          </div>
          {selected !== undefined && (
            <BrainDetail key={selected} id={selected} onSelect={onSelect} onClose={() => onSelect(undefined)} editable={editable}
              className="hidden w-[340px] md:grid" />
          )}
        </div>
      </div>
    </DialogBackdrop>
  )
}
