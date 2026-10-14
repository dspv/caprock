/**
 * "How it works" for Second Brain (ADR-062): what it is in four short lines,
 * a calm picture of a graph, and the app's usual Premium purchase step.
 *
 * Sold ahead of its arrival, so the line under the prices is a dated
 * pre-order with a refund promise, worded exactly as the owner set it
 * (2026-10-14) — never "coming soon" (rule 11). Someone who already has
 * Premium is told it is included and when it arrives, and offered nothing.
 * Nothing here sends anything; a purchase goes through the existing Stripe
 * checkout, in the browser.
 */
import { useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { useLicensed } from '@/lib/nudges'
import { SECOND_BRAIN_DATE_TEXT } from '@/lib/offer'
import { UpsellDialog } from './UpsellDialog'
import { Price } from './PremiumModal'

export const PREORDER_LINE = `Second Brain comes to Premium on ${SECOND_BRAIN_DATE_TEXT}. If it doesn't, write to us for a full refund.`
export const INCLUDED_LINE = `It's included in your Premium — it arrives on ${SECOND_BRAIN_DATE_TEXT}.`

const LINES: [string, string][] = [
  ['What goes in', 'the ideas, decisions and findings from your sessions, plus anything you drop in.'],
  ['Where', 'a block on the left, and a full-screen graph with search.'],
  ['Local', 'it stays on this computer.'],
  ['Remembers', 'new sessions can draw on what you already know.'],
]

export function SecondBrainModal({ onClose }: { onClose: () => void }) {
  const licensed = useLicensed()
  const pricing = useApi(() => api.premium(), [])
  const [buying, setBuying] = useState(false)
  return (
    <UpsellDialog
      label="Second Brain"
      eyebrow="Caprock Premium"
      title="Your second brain"
      onClose={onClose}
      picture={<Graph />}
      actions={licensed
        ? <p className="text-[13px] text-fg" data-sb-included>{INCLUDED_LINE}</p>
        : (
          <div>
            {buying
              ? <Price p={pricing.data} feature="second-brain" onClose={onClose} />
              : (
                <button type="button" onClick={() => setBuying(true)}
                  className="w-full rounded-md bg-accent px-3 py-2 text-center text-[14px] font-semibold text-panel hover:bg-accent-strong">
                  Get Premium
                </button>
              )}
            <p className="mt-2 text-[11.5px] leading-snug text-fg-muted" data-sb-preorder>{PREORDER_LINE}</p>
          </div>
        )}
      footer={
        <div className="flex items-center gap-3">
          <button type="button" onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">Close</button>
        </div>
      }
    >
      <p className="text-[13.5px] leading-relaxed text-fg-muted">A knowledge graph of everything your agents do.</p>
      <ul className="mt-3 space-y-1.5 text-[13px] leading-snug">
        {LINES.map(([k, v]) => (
          <li key={k}><span className="font-semibold text-fg">{k}:</span> <span className="text-fg-muted">{v}</span></li>
        ))}
      </ul>
    </UpsellDialog>
  )
}

/**
 * A still picture of a small graph: a few linked ideas around one centre.
 * Theme tokens only; no motion.
 */
function Graph() {
  const nodes: [number, number, number][] = [
    [160, 70, 9], [92, 40, 6], [232, 36, 6], [70, 104, 5], [248, 108, 6],
    [128, 118, 5], [200, 124, 5], [38, 58, 4], [290, 70, 4], [180, 20, 4],
  ]
  const links: [number, number][] = [
    [0, 1], [0, 2], [0, 4], [0, 5], [0, 6], [1, 3], [1, 7], [2, 8], [2, 9], [4, 8], [5, 3], [6, 4], [1, 9],
  ]
  return (
    <div className="h-[132px] rounded-[12px] border border-border bg-panel-2/50 p-2">
      <svg viewBox="0 0 320 140" className="block h-full w-full" aria-hidden="true">
      {links.map(([a, b]) => (
        <line key={`${a}-${b}`} x1={nodes[a]![0]} y1={nodes[a]![1]} x2={nodes[b]![0]} y2={nodes[b]![1]}
          stroke="var(--color-border-strong)" strokeWidth="1.4" />
      ))}
      {nodes.map(([x, y, r], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill={i === 0 ? 'var(--color-accent)' : 'var(--color-panel)'}
          stroke="var(--color-accent)" strokeWidth={i === 0 ? 0 : 1.6} />
      ))}
      </svg>
    </div>
  )
}
