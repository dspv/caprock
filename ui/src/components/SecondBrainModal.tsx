/**
 * "How it works" for Second Brain (ADR-063), opened from the sidebar's Second
 * Brain block. A newcomer should get it in ten seconds: what it does in one
 * line, the long-term promise (the owner's "personal Jarvis") said plainly,
 * how in three short steps, and where the data goes.
 *
 * The defaults named in step two are the daemon's (internal/brain/engine.go:
 * DefaultModel "haiku", DefaultDailyTokens 300,000), and the handoff takes up
 * to five of a repository's memories (ADR-063). Change them together.
 * "This computer", not "this Mac": the dialog ships on all three OSes.
 *
 * Second Brain is free (owner decision, 2026-10-14). There is nothing to buy
 * here; the one action opens the Brain screen. Nothing here sends anything.
 */
import { UpsellDialog } from './UpsellDialog'

const STEPS: [string, string][] = [
  ['Your sessions end.', 'Once you say yes, each session that finishes, or goes quiet for ten minutes, is queued.'],
  ['Your own claude reads them on this computer.', 'It keeps the decisions, findings, ideas and open questions. Haiku and at most 300k tokens a day by default; change either in Settings.'],
  ['The next agent starts smarter.', 'The best few — up to five of the project’s memories — go into the handoff of the next session you start there.'],
]

export function SecondBrainModal({ onClose, onOpen }: { onClose: () => void; onOpen?: () => void }) {
  return (
    <UpsellDialog
      label="Second Brain"
      eyebrow="Second Brain · how it works"
      title="Remembers what your agents learn — so the next one starts smarter"
      onClose={onClose}
      picture={<Graph />}
      actions={onOpen && (
        <button type="button" onClick={() => { onOpen(); onClose() }}
          className="w-full rounded-md bg-accent px-3 py-2 text-center text-[14px] font-semibold text-panel hover:bg-accent-strong">
          Open Second Brain
        </button>
      )}
      footer={
        <div className="flex items-center gap-3">
          <button type="button" onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">Close</button>
        </div>
      }
    >
      <p className="text-[13.5px] leading-relaxed text-fg">
        It remembers what your agents learn — decisions, findings, ideas, open questions — and hands the
        relevant ones to the next agent you start.
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted" data-brain-jarvis>
        Over time it becomes your personal Jarvis: an assistant that knows your projects.
      </p>
      <ol className="mt-3 space-y-2 text-[13px] leading-snug" aria-label="How it works">
        {STEPS.map(([k, v], i) => (
          <li key={k} className="flex gap-2.5">
            <span aria-hidden="true"
              className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-accent font-mono text-[11px] text-accent">
              {i + 1}
            </span>
            <span><span className="font-semibold text-fg">{k}</span> <span className="text-fg-muted">{v}</span></span>
          </li>
        ))}
      </ol>
      <p className="mt-3 rounded-md border border-border bg-panel-2/50 px-3 py-2 text-[12.5px] leading-snug text-fg-muted" data-brain-privacy>
        <span className="font-semibold text-fg">Private.</span> Nothing leaves your computer except the call
        your own claude makes. Turn it off in Settings → Second Brain any time.
      </p>
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
    <div className="h-[96px] rounded-[12px] border border-border bg-panel-2/50 p-2">
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
