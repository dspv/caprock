/**
 * The sidebar's Brain block (ADR-063), below the projects: the owner's
 * "collapsible block on the left where my second brain is constantly being
 * built" (translated). A small graph of the newest thirty memories, where a
 * new one drops in as it is kept (components/BrainGraphCanvas), the three
 * newest titles and the count. A title or a dot opens it on `#/brain`.
 *
 * Folds like the footer and remembers it; unfolded by default, for everyone
 * — Second Brain is free (owner decision, 2026-10-14). *How it works* opens
 * a short explainer with a way into the Brain screen.
 */
import { useState } from 'react'
import { isEntity, useBrainGraph, useBrainStatus } from '@/lib/brain'
import { keys } from '@/lib/appkeys'
import { BrainGraphCanvas } from './BrainGraphCanvas'
import { ChevronIcon } from './AppIcons'
import { SecondBrainModal } from './SecondBrainModal'

const FOLD_KEY = 'caprock.app.brain-fold'
const NEWEST = 30

function readFold(): 'open' | 'closed' | null {
  try {
    const v = localStorage.getItem(FOLD_KEY)
    return v === 'open' || v === 'closed' ? v : null
  } catch {
    return null
  }
}

export function BrainSidebar({ onOpen }: { onOpen: (hash: string) => void }) {
  const { status } = useBrainStatus()
  const [fold, setFold] = useState(readFold)
  const [how, setHow] = useState(false)
  const open = fold ? fold === 'open' : true
  const { graph } = useBrainGraph(open ? { limit: NEWEST } : { limit: 1 }, 600)
  const toggle = () => {
    const next = open ? 'closed' : 'open'
    setFold(next)
    try { localStorage.setItem(FOLD_KEY, next) } catch { /* private window */ }
  }
  if (!status) return null
  const newest = (graph?.nodes ?? []).filter((n) => !isEntity(n.kind)).sort((a, b) => b.created_at - a.created_at).slice(0, 3)
  const auto = status.auto?.enabled
  return (
    <section className="mt-3 border-t border-[var(--app-hairline)] pt-1" aria-label="Second Brain" data-brain-sidebar>
      <div className="flex h-[28px] items-center gap-1.5 px-2 pt-1.5">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-faint">Brain</h2>
          {auto && <span className="text-[10.5px] text-fg-faint" title="Built from your finished sessions">· building</span>}
        </button>
        <button
          type="button"
          onClick={() => onOpen('#/brain')}
          className="num text-[11.5px] text-fg-faint hover:text-fg"
          title={`${status.memories} ${status.memories === 1 ? 'memory' : 'memories'} — open Second Brain`}
        >
          {status.memories}
        </button>
        <button
          type="button"
          onClick={toggle}
          aria-label={open ? 'Fold Brain' : 'Unfold Brain'}
          className="flex h-[20px] w-[20px] items-center justify-center rounded-[5px] text-fg-faint hover:bg-[var(--app-row-hover)] hover:text-fg"
        >
          <span className={`flex transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden>
            <ChevronIcon size={10} />
          </span>
        </button>
      </div>
      {open && (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 px-1 pt-1">
          {graph && graph.total > 0 ? (
            <>
              <BrainGraphCanvas
                mini
                graph={graph}
                onSelect={(id) => onOpen(`#/brain?node=${id}`)}
                className="h-[118px] rounded-[8px] bg-[var(--app-row-hover)]"
                ariaLabel={`Your newest ${Math.min(graph.total, NEWEST)} memories as a graph`}
              />
              <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-px">
                {newest.map((n) => (
                  <li key={n.id} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => onOpen(`#/brain?node=${n.id}`)}
                      title={n.title}
                      className="block w-full truncate rounded-[6px] px-1.5 py-[3px] text-left text-[12px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
                    >
                      {n.title}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="px-1.5 py-1 text-[12px] leading-snug text-fg-faint">
              Nothing kept yet. Drop an answer in from Memory or a chat, or {keys('⇧⌘H')}.
            </p>
          )}
          <button type="button" onClick={() => setHow(true)} className="justify-self-start px-1.5 text-[11.5px] text-fg-faint hover:text-fg hover:underline">
            How it works
          </button>
        </div>
      )}
      {how && <SecondBrainModal onOpen={() => onOpen('#/brain')} onClose={() => setHow(false)} />}
    </section>
  )
}
