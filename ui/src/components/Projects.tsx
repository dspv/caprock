/**
 * Projects — per-repo spend, the first thing a user recognises as their own
 * money. Cost per project already existed in the summary but was buried in
 * History; this puts it on the landing screen, answering both halves of the
 * real question: what does this repo cost, and who is working in it right now.
 *
 * A row is a REPOSITORY, not a directory. It used to be the basename of the
 * session's cwd, which split one repo across several rows (`caprock` and `ui`)
 * and, worse, summed unrelated repos that happened to share a name. Each row
 * expands to the breakdown one level down — what `ui` cost of `caprock`'s
 * total — because "which part of the monorepo is burning the budget" is the
 * question a per-repo number raises and cannot answer on its own.
 *
 * Two things the row shows are choices worth stating.
 *
 * The measure toggle ($ / tokens) exists because on a subscription plan dollars
 * are not what the user pays — they are a proxy for consumption, and the number
 * that reflects what was actually consumed is tokens. Cost stays the default
 * because it is the figure people recognise; tokens become the headline for
 * anyone whose bill is flat. Whichever is chosen drives the sparkline too, so
 * the picture can never contradict the number beside it.
 *
 * The sparkline REPLACED a share-of-largest bar. The bar restated the ranking
 * the sorted, right-aligned numbers already gave — the widest bar sat on the
 * top row by construction — so it spent the row's only free horizontal space on
 * information the reader had. When the spend happened is not in any number
 * here: a repo that cost $40 in one afternoon and one that cost $40 across
 * three weeks are the same row until you draw them.
 *
 * Every number here is measured from captured events at API list price — never
 * modelled, never extrapolated (rule 6).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type PathShare, type ProjectShare, type SessionSummary } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtTokens, fmtUSD } from '@/lib/format'
import { buildSpark, bucketLabel, peak, type Measure } from '@/lib/spark'
import { Panel, Skeleton } from '@/components/ui'

type Range = 'today' | '7d' | '30d' | 'all'

const RANGES: { key: Range; label: string }[] = [
  { key: 'today', label: 'today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: 'all', label: 'all' },
]

const MEASURES: { key: Measure; label: string }[] = [
  { key: 'cost', label: '$' },
  { key: 'tokens', label: 'tokens' },
]

/** The measure choice is persisted: it reflects how the user is billed, which
 *  does not change between visits, so re-picking it every reload would be a
 *  chore. The range is not persisted — that is a question you ask per visit.
 *  localStorage is the mechanism the dashboard already uses (see lib/theme.ts). */
const MEASURE_KEY = 'caprock-projects-measure'

function initialMeasure(): Measure {
  try {
    return localStorage.getItem(MEASURE_KEY) === 'tokens' ? 'tokens' : 'cost'
  } catch {
    // Private-mode / disabled storage must not take the panel down with it.
    return 'cost'
  }
}

export function ProjectsPanel({ sessions }: { sessions: SessionSummary[] }) {
  // 30d is the default: "today" is near-empty most mornings and would make the
  // panel look broken on first open, which is exactly the wrong first impression.
  const [range, setRange] = useState<Range>('30d')
  const [measure, setMeasure] = useState<Measure>(initialMeasure)
  const [expanded, setExpanded] = useState(false)
  const summary = useApi(() => api.summary(range), [range], { intervalMs: 30000 })

  useEffect(() => {
    try {
      localStorage.setItem(MEASURE_KEY, measure)
    } catch {
      // Nothing to do — the choice simply will not survive the reload.
    }
  }, [measure])

  const all = summary.data?.projects ?? []
  const shown = expanded ? all : all.slice(0, 6)
  const totalCost = all.reduce((sum, p) => sum + p.cost_usd, 0)
  const totalTokens = all.reduce((sum, p) => sum + p.tokens, 0)

  // The tallest column across the rows on screen, so every sparkline is drawn
  // to one ceiling and the pictures are comparable between rows.
  const ceiling = useMemo(() => peak(shown.map((p) => p.spark), measure), [shown, measure])
  // The row scale for the fallback bar, in the selected measure.
  const maxRow = useMemo(
    () => shown.reduce((hi, p) => Math.max(hi, measure === 'tokens' ? p.tokens : p.cost_usd), 0),
    [shown, measure],
  )

  return (
    <Panel
      title="Projects"
      right={
        <span className="flex items-center gap-2">
          <span className="num text-fg text-[13px]">
            {measure === 'tokens' ? `${fmtTokens(totalTokens)} total` : `${fmtUSD(totalCost)} total`}
          </span>
          {/* Same chrome as the range buttons: this is the same kind of control
            * — it changes what the panel shows, not what it is. */}
          <span className="inline-flex border border-border rounded-sm overflow-hidden" role="group" aria-label="measure">
            {MEASURES.map((m) => (
              <button
                key={m.key}
                onClick={() => setMeasure(m.key)}
                aria-pressed={measure === m.key}
                title={
                  m.key === 'tokens'
                    ? 'show tokens as the headline — what was consumed'
                    : 'show cost as the headline — API list price'
                }
                className={`px-1.5 py-0.5 text-[11px] mono ${
                  measure === m.key ? 'bg-panel-2 text-fg' : 'text-fg-faint hover:text-fg-muted'
                }`}
              >
                {m.label}
              </button>
            ))}
          </span>
          <span className="inline-flex border border-border rounded-sm overflow-hidden">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`px-1.5 py-0.5 text-[11px] mono ${
                  range === r.key ? 'bg-panel-2 text-fg' : 'text-fg-faint hover:text-fg-muted'
                }`}
              >
                {r.label}
              </button>
            ))}
          </span>
        </span>
      }
    >
      {!summary.data ? (
        <Skeleton rows={5} />
      ) : all.length === 0 ? (
        <div className="px-3 py-4 text-[12px] text-fg-muted">
          No spend captured in this range yet.
        </div>
      ) : (
        <div className="grid">
          {shown.map((p) => (
            <ProjectRow
              key={p.project || '(unknown)'}
              p={p}
              max={maxRow}
              ceiling={ceiling}
              measure={measure}
              live={liveIn(sessions).has(p.project)}
            />
          ))}
          {all.length > 6 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-fg-faint hover:text-fg-muted px-3 py-1.5 text-left border-t border-border"
            >
              {expanded ? 'show less' : `show all ${all.length} projects`}
            </button>
          )}
        </div>
      )}
    </Panel>
  )
}

/** Projects with a session that is live right now — the "who is in it" signal. */
function liveIn(sessions: SessionSummary[]): Set<string> {
  return new Set(sessions.filter((s) => s.status !== 'ended').map((s) => s.project).filter(Boolean))
}

function ProjectRow({
  p,
  max,
  ceiling,
  measure,
  live,
}: {
  p: ProjectShare
  max: number
  ceiling: number
  measure: Measure
  live: boolean
}) {
  // The breakdown is absent for a repository whose work all happened in one
  // directory: a single child row would restate the parent's own total.
  const paths = p.paths ?? []
  const expandable = paths.length > 1
  const [open, setOpen] = useState(false)
  const label = p.project || 'unknown project'
  const value = measure === 'tokens' ? p.tokens : p.cost_usd
  // Share-of-the-largest, in the SELECTED measure. A bar still scaled on cost
  // while the headline reads tokens would contradict the number above it — the
  // two orderings genuinely differ, because a cheap model burns tokens cheaply.
  const pct = max > 0 ? (100 * value) / max : 0
  const bars = useMemo(() => buildSpark(p.spark, measure, ceiling), [p.spark, measure, ceiling])

  const body = (
    <div className="grid grid-cols-[1fr_128px_auto] items-center gap-3 w-full text-left">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {live && <span className="inline-block w-1.5 h-1.5 rounded-full bg-ok shrink-0" title="a session is live in this project" />}
          <span className="truncate text-[14px]">{label}</span>
          <span className="text-[11px] text-fg-faint num shrink-0">
            {p.sessions} {p.sessions === 1 ? 'session' : 'sessions'}
          </span>
          {expandable && (
            // The caret is the only affordance, so it carries the state: a
            // chevron that turns, in the faint tone used for chrome elsewhere.
            <span
              aria-hidden
              className={`text-[9px] text-fg-faint shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            >
              ▶
            </span>
          )}
        </div>
      </div>
      {/* The sparkline sits between the name and the number, in its own fixed
        * column, so the numbers stay on one right-aligned edge and the pictures
        * on another. Ragged columns are what make a dense table unreadable. */}
      {bars.length > 0 ? (
        <SparkCanvas bars={bars} widthMs={p.spark?.width_ms ?? 0} measure={measure} label={label} />
      ) : (
        // `range=all` sends no series (its buckets would have no stated width),
        // so the row keeps the share bar rather than showing an empty gap.
        <div className="h-1 bg-panel-2 rounded-sm overflow-hidden" title={`${label}: share of the largest project`}>
          <div className="h-full bg-accent/70" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="text-right shrink-0">
        {measure === 'tokens' ? (
          <>
            <div className="num text-[17px] font-semibold leading-tight text-accent">{fmtTokens(p.tokens)}</div>
            <div className="num text-[11px] text-fg-faint">{fmtUSD(p.cost_usd)}</div>
          </>
        ) : (
          <>
            <div className="num text-[17px] font-semibold leading-tight text-accent">{fmtUSD(p.cost_usd)}</div>
            <div className="num text-[11px] text-fg-faint">{fmtTokens(p.tokens)}</div>
          </>
        )}
      </div>
    </div>
  )

  return (
    <div className="border-t border-border first:border-t-0">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="w-full px-3 py-1.5 hover:bg-panel-2/50"
          title={`${label}: show cost by directory`}
        >
          {body}
        </button>
      ) : (
        <div className="px-3 py-1.5">{body}</div>
      )}
      {expandable && open && (
        <div className="pb-1.5 bg-panel-2/30">
          {paths.map((q) => (
            <PathRow
              key={q.path}
              q={q}
              max={measure === 'tokens' ? paths[0]!.tokens : paths[0]!.cost_usd}
              measure={measure}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One directory inside a repository. Indented and quieter than its parent so
 * the eye keeps the repository as the unit and reads these as its parts; the
 * bar is a share of the largest directory, matching how the parent rows work.
 *
 * There is no sparkline here on purpose: a series per directory would multiply
 * the payload of a polled endpoint for a picture that is hidden until the row
 * is expanded, and the question a breakdown answers is "how much", not "when".
 */
function PathRow({ q, max, measure }: { q: PathShare; max: number; measure: Measure }) {
  const value = measure === 'tokens' ? q.tokens : q.cost_usd
  const pct = max > 0 ? (100 * value) / max : 0
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 pl-7 pr-3 py-1">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {/* "." is the repository root itself, which reads as nothing at all
              in a list of directory names. */}
          <span className="truncate text-[12px] text-fg-muted mono">
            {q.path}
          </span>
          <span className="text-[10px] text-fg-faint num shrink-0">
            {q.sessions} {q.sessions === 1 ? 'session' : 'sessions'}
          </span>
        </div>
        <div className="h-0.5 mt-1 bg-panel-2 rounded-sm overflow-hidden">
          <div className="h-full bg-accent/40" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="num text-[12px] text-fg-muted">
          {measure === 'tokens' ? fmtTokens(q.tokens) : fmtUSD(q.cost_usd)}
        </div>
      </div>
    </div>
  )
}

/**
 * The sparkline canvas. Painted the way Pulse.tsx paints its track — on data
 * change rather than on a timer, with an empty bucket drawn as a hairline so a
 * quiet day reads as silence instead of as a hole in the chart.
 *
 * Unlike Pulse, the colours are read from the design tokens rather than
 * hardcoded rgba, because this canvas sits in a panel that is also rendered in
 * the light theme, where Pulse's fixed dark-theme colours would be wrong.
 */
function SparkCanvas({
  bars,
  widthMs,
  measure,
  label,
}: {
  bars: ReturnType<typeof buildSpark>
  widthMs: number
  measure: Measure
  label: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const paint = () => {
      const w = cv.clientWidth
      const h = cv.clientHeight
      if (w === 0 || h === 0) return
      const dpr = window.devicePixelRatio || 1
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // Tokens from the stylesheet, so the sparkline follows the theme. A
      // canvas cannot use a CSS variable directly, so it is resolved once per
      // paint against the element itself.
      const css = getComputedStyle(cv)
      const accent = css.getPropertyValue('--color-accent').trim() || '#feb157'
      const faint = css.getPropertyValue('--color-fg-faint').trim() || '#837f78'

      const bw = w / bars.length
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i]
        if (!b) continue
        const x = i * bw
        // A one-pixel gutter keeps 30 columns from fusing into a solid block,
        // but never at the cost of the column itself disappearing.
        const width = Math.max(1, bw - 1)
        if (b.empty) {
          // Silence, drawn rather than left blank — the same hairline the live
          // pulse uses, so an empty bucket is visibly distinct from a low one.
          ctx.fillStyle = faint
          ctx.globalAlpha = 0.28
          ctx.fillRect(x, h - 1, width, 1)
          ctx.globalAlpha = 1
          continue
        }
        // A non-empty bucket is never shorter than 2px: at this height a
        // faithful sub-pixel column would be indistinguishable from silence,
        // and "a little" must not render as "nothing".
        const bh = Math.max(2, b.height * h)
        ctx.fillStyle = accent
        // Muted against the headline number, which is the same accent at full
        // strength — the picture supports the figure, it does not compete.
        ctx.globalAlpha = 0.65
        ctx.fillRect(x, h - bh, width, bh)
        ctx.globalAlpha = 1
      }
    }
    paint()
    // Repaint on resize only — the data itself arrives through the effect deps.
    const ro = new ResizeObserver(paint)
    ro.observe(cv)
    return () => ro.disconnect()
  }, [bars])

  // The whole picture gets one title rather than a hover readout per column:
  // at 14px tall a column is not a hit target, and the row is already a button
  // that expands the breakdown — stealing its clicks would break that.
  const spent = bars.filter((b) => !b.empty)
  const first = spent[0]
  const last = spent[spent.length - 1]
  const span =
    !first || !last
      ? 'no spend in this range'
      : first === last
        ? `all of it on ${bucketLabel(first.at, widthMs)}`
        : `${bucketLabel(first.at, widthMs)} → ${bucketLabel(last.at, widthMs)}`

  return (
    <canvas
      ref={ref}
      className="w-full h-[14px] block"
      role="img"
      aria-label={`${label}: ${measure === 'tokens' ? 'tokens' : 'cost'} over time, ${span}`}
      title={`${label}: when the spend happened — ${span}`}
    />
  )
}
