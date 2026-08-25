/**
 * BarChart — the daily-cost bars, with a readable answer on hover.
 *
 * The bars used to carry only a native `title` tooltip. That is a real answer
 * but it arrives after a browser delay, in the OS font, detached from the
 * chart — long enough that a user hovers, sees nothing happen, and concludes
 * the chart is not interactive. Reported exactly that way by an early user.
 *
 * So: the hovered bar highlights immediately, its figures appear in the panel
 * header where the eye already is, and the day under the cursor is marked.
 * Keyboard users get the same via focus, because a chart that only answers a
 * mouse answers half the people.
 */
import { fmtTokens, fmtUSD } from '@/lib/format'

/**
 * Gridline values for a chart whose tallest bar is `max`.
 *
 * Rounded up to a 1/2/5×10ⁿ step, because a rule labelled "$237.83" is a
 * measurement of one particular day rather than a ruler you can read the other
 * bars against — which is the entire job of the line. Two or three rules: any
 * more and they compete with the bars they exist to explain.
 */
function gridLines(max: number): number[] {
  if (!Number.isFinite(max) || max <= 0) return []
  // max/3, not max/2: rounding a half-max step UP to a nice number almost
  // always lands above half the height, leaving exactly one line on the
  // chart. A ruler with one mark is barely a ruler — this yields two or
  // three, which is what you need to read a bar against.
  const rough = max / 3
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= rough) ?? mag * 10
  const lines: number[] = []
  for (let v = step; v <= max * 1.0001; v += step) lines.push(v)
  return lines
}

export interface Bar {
  /** ISO day, e.g. "2026-08-20". */
  day: string
  cost: number
  tokens: number
  sessions?: number
}

export function BarChart({ bars, active, onActive, height = 112, showDayLabels = true }: {
  bars: Bar[]
  /** Day currently under the cursor or focus, owned by the caller so the
   *  panel header can display its figures. */
  active: string | null
  onActive: (day: string | null) => void
  height?: number
  showDayLabels?: boolean
}) {
  // Math.max returns NaN if any input is NaN, which made every bar height NaN
  // and blanked the whole chart — not just the bad day — while the header total
  // still showed a number. One absent cost_usd in a rollup row does it.
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const max = Math.max(...bars.map((b) => num(b.cost)), 1e-9)
  const barHeight = height - 16
  const lines = gridLines(max)

  return (
    <div
      className="relative px-3 py-3 flex items-end gap-[3px]"
      style={{ height }}
      onMouseLeave={() => onActive(null)}
    >
      {/* The ruler. Bars are normalised to the tallest one, so without a
        * labelled line a height means nothing — there was no way to tell a
        * $20 day from a $200 one. Behind the bars and dim: it is a reference,
        * not content. */}
      {lines.map((v) => (
        <div
          key={v}
          className="pointer-events-none absolute left-3 right-3 border-t border-border/60"
          style={{ bottom: 16 + Math.round((barHeight * v) / max) }}
          aria-hidden
        >
          <span className="num absolute -top-[7px] right-0 bg-panel pl-1 text-[9px] text-fg-faint">
            {fmtUSD(v)}
          </span>
        </div>
      ))}

      {bars.map((b) => {
        const on = active === b.day
        return (
          <button
            key={b.day}
            type="button"
            className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0 h-full cursor-default focus:outline-none"
            onMouseEnter={() => onActive(b.day)}
            onFocus={() => onActive(b.day)}
            onBlur={() => onActive(null)}
            aria-label={`${b.day}: ${fmtUSD(num(b.cost))}`}
          >
            <div
              className={`w-full rounded-t-sm transition-colors ${on ? 'bg-accent' : 'bg-accent/70'}`}
              style={{ height: Math.max(2, Math.round((barHeight * num(b.cost)) / max)) }}
            />
            {showDayLabels && (
              <div className={`num text-[9px] ${on ? 'text-fg' : 'text-fg-faint'}`}>{b.day.slice(8)}</div>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * BarReadout is the panel-header figure: the total normally, and the hovered
 * day's numbers while a bar is active — placed where the eye already is rather
 * than in a tooltip that has to be waited for.
 */
export function BarReadout({ bars, active, total }: {
  bars: Bar[]
  active: string | null
  total: number
}) {
  const b = active ? bars.find((x) => x.day === active) : undefined
  if (!b) return <span className="num">{fmtUSD(total)}</span>
  return (
    <span className="num flex items-baseline gap-2">
      <span className="text-fg-muted">{b.day}</span>
      <span className="text-fg">{fmtUSD(b.cost)}</span>
      <span className="text-fg-faint">{fmtTokens(b.tokens)}</span>
      {/* A zero here means the daily rollup has no session count for that day,
        * not that nobody worked — printing "0 sessions" next to a $257 day
        * reads as a data bug and taints the two figures beside it. */}
      {b.sessions !== undefined && b.sessions > 0 && (
        <span className="text-fg-faint">
          {b.sessions} {b.sessions === 1 ? 'session' : 'sessions'}
        </span>
      )}
    </span>
  )
}
