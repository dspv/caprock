/**
 * The month as a calendar, one dot per day.
 *
 * Thirty bars in a row answer "how much on the 14th" and hide the thing a
 * person actually recognises about their own month: that they work weekdays,
 * that one week ran hot, that a Sunday was quiet. A week per row puts the same
 * weekday in the same column, so the rhythm is visible without reading a
 * single figure.
 *
 * Cost is carried by shade at a constant cell size, the way a contribution
 * graph does it. Sizing each mark instead leaves a ragged grid where the
 * columns stop lining up, and the columns are the whole point — they are what
 * makes "I do not work Sundays" visible at a glance.
 *
 * Five steps, cut on a square-root scale rather than linearly. A handful of
 * heavy days sets the maximum, so linear buckets put almost every real day in
 * the palest step and the month reads as empty when it was not.
 */
import { fmtUSD } from '@/lib/format'
import type { Bar } from './BarChart'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** Monday-first weekday index, 0–6. `Date.getUTCDay()` is Sunday-first. */
function weekdayIndex(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return (d + 6) % 7
}

/**
 * Which of five steps a day falls into. A day with any spend never returns the
 * empty step: "something happened here" is the one distinction the grid must
 * never lose, and rounding a $2 day down to blank loses it.
 */
function shade(cost: number, max: number): string {
  if (!(cost > 0)) return 'bg-border/60'
  const t = Math.sqrt(cost / Math.max(max, 1e-9))
  if (t > 0.75) return 'bg-accent'
  if (t > 0.5) return 'bg-accent/75'
  if (t > 0.25) return 'bg-accent/50'
  return 'bg-accent/25'
}

export function DayGrid({ bars, active, onActive, maxCell = 44 }: {
  bars: Bar[]
  active: string | null
  onActive: (day: string | null) => void
  /** Ceiling on cell size; the grid fills its container up to this. */
  maxCell?: number
}) {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const max = Math.max(...bars.map((b) => num(b.cost)), 1e-9)

  // Lead the first row with blanks so every column is one weekday. Without
  // this the grid is just a 7-wide wrap and the columns mean nothing.
  const first = bars[0]
  const lead = first ? weekdayIndex(first.day) : 0

  return (
    <div className="px-3 py-3" onMouseLeave={() => onActive(null)}>
      {/* Fills the panel rather than sitting in a fixed clump in the corner.
        * Capped so that on a wide screen the cells stay squares you read as a
        * calendar instead of stretching into stripes. */}
      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          maxWidth: maxCell * 7 + 6 * 4,
        }}
      >
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="text-center text-[9px] text-fg-faint" aria-hidden>
            {w}
          </div>
        ))}

        {Array.from({ length: lead }, (_, i) => (
          <div key={`lead-${i}`} aria-hidden />
        ))}

        {bars.map((b) => {
          const cost = num(b.cost)
          const on = active === b.day
          return (
            <button
              key={b.day}
              type="button"
              className="flex aspect-square items-center justify-center focus:outline-none cursor-default"

              onMouseEnter={() => onActive(b.day)}
              onFocus={() => onActive(b.day)}
              onBlur={() => onActive(null)}
              aria-label={`${b.day}: ${fmtUSD(cost)}`}
            >
              <span
                className={`h-full w-full rounded-[3px] transition-colors ${shade(cost, max)} ${
                  on ? 'ring-1 ring-accent ring-offset-1 ring-offset-panel' : ''
                }`}
              />
            </button>
          )
        })}
      </div>

      {/* The key. Five shades with no scale is a decoration; with the two ends
        * labelled in money it is a chart you can read a day against. */}
      <div className="mt-3 flex items-center gap-1.5 text-[9px] text-fg-faint">
        <span>$0</span>
        {['bg-border/60', 'bg-accent/25', 'bg-accent/50', 'bg-accent/75', 'bg-accent'].map((c) => (
          <span key={c} className={`h-2 w-2 rounded-[2px] ${c}`} aria-hidden />
        ))}
        <span className="num">{fmtUSD(max)}</span>
      </div>
    </div>
  )
}
