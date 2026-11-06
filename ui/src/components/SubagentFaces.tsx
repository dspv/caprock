/**
 * The hero's subagents, drawn with the brand characters (.ai/04-ui.md §
 * Inspector, the subagent chart; lib/subagentfaces for the arithmetic).
 * Three looks the viewer switches between with three small dots, the matrix
 * by default (owner, 2026-11-06, translated: "on the right I just want a
 * matrix of agent thumbnails and the main agent's icon, that's all — and
 * swap: pictures on the left, figures on the right"):
 *
 * - **Matrix**: no frame; beside the agent's large tile (drawn by the
 *   caller) the subagents' faces in a grid of four columns, the working in
 *   colour, the finished grey, a *+N* tile past eight. Hovering the grid, or
 *   a key into it, shows *1 working · peak 4*, which opens the hour's chart
 *   under the row, and the three dots.
 * - **Faces as chips**: the chips under the figures are the subagents'
 *   faces (SubagentStrip in Cockpit), *1 working · peak 4* beside them, a
 *   click on it opens the hour's chart under the row.
 * - **Strip**: one line, the working faces big and breathing, the finished
 *   small and grey, *1 working · peak 4*, and the hour as a sparkline whose
 *   click opens the full chart in place.
 *
 * The faces are the one chosen for Claude in Settings, or picked from its
 * random pool by a stable key (the subagent's id), so nothing reshuffles on
 * a re-render.
 */
import { useState, type ReactNode } from 'react'
import type { SubagentsNow, SubagentHour } from '@/lib/api'
import type { SubagentChip } from '@/lib/cockpit'
import type { Face } from '@/lib/faces'
import { useFaceDefault } from '@/lib/faces'
import { Body } from './Characters'
import {
  FRESH_MINUTES, SUBAGENT_LOOKS, clockTime, peakMinute, setSubagentLook, sparkPoints, subagentFace, subagentSummary, useSubagentLook,
  type SubagentLook,
} from '@/lib/subagentfaces'

/** The most working faces the strip draws before "+N", and the most finished. */
const STRIP_WORKING = 6
const STRIP_DONE = 3
/** The strip's sparkline, px. */
const SPARK_W = 80
const SPARK_H = 16

/** One character's face, cropped tighter than its 80px scene so a small one still reads. */
export function SubFace({ face, size, className }: { face?: Face; size?: number; className?: string }) {
  return (
    <svg viewBox="6 8 68 68" aria-hidden="true" className={className} data-face={face}
      style={size ? { width: size, height: size, flex: 'none', display: 'block' } : { flex: 'none', display: 'block' }}>
      <Body who="lead" face={face} />
    </svg>
  )
}

function subagents(n: number): string {
  return `${n} ${n === 1 ? 'subagent' : 'subagents'}`
}

/**
 * Whether the session had any subagent the hero can speak of: one working
 * now, one finished lately, or any in the last hour. With none, the strip
 * and the chips' line are not drawn at all.
 */
export function anySubagents(subs: SubagentsNow | undefined, count: number): boolean {
  if (!subs) return false
  return count > 0 || subs.working.length > 0 || (subs.recent?.length ?? 0) > 0 || subs.finished > 0 || (subs.hour?.peak ?? 0) > 0
}

function Axis() {
  return (
    <div data-hero-axis aria-hidden="true" className="num flex justify-between text-[10px] leading-[14px] text-fg-faint">
      <span>1h ago</span><span>30m</span><span>now</span>
    </div>
  )
}

/** The three looks as three small dots, at the end of the subagents' line. */
function LookSwitch({ look }: { look: SubagentLook }) {
  return (
    <span role="group" aria-label="How the subagents are drawn" data-subagent-looks className="flex shrink-0 items-center">
      {SUBAGENT_LOOKS.map((l) => (
        <button key={l.id} type="button" title={l.name} aria-label={l.name} aria-pressed={look === l.id} data-look={l.id}
          onClick={() => setSubagentLook(l.id)}
          className="group grid h-[14px] w-[11px] place-items-center rounded-[3px] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
          <span className={`block h-[5px] w-[5px] rounded-full ${look === l.id ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-fg-faint)] opacity-50 group-hover:opacity-100'}`} />
        </button>
      ))}
    </span>
  )
}

/** The hour's minutes as bars, scaled to the peak, the last ten minutes in full. */
function MinuteBars({ hour, h }: { hour: SubagentHour; h: number }) {
  const W = 300
  const n = Math.max(1, hour.counts.length)
  const bw = W / n
  const fresh = n - FRESH_MINUTES
  return (
    <svg data-hero-bars viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" role="img" data-empty={hour.peak === 0 || undefined}
      aria-label={hour.peak > 0 ? `Subagents at work each minute of the last hour, at most ${hour.peak} at once` : 'No subagents in the last hour'}
      className="cockpit-subbars block w-full" style={{ height: h }}>
      <line className="base" x1="0" x2={W} y1={h - 0.5} y2={h - 0.5} />
      {hour.peak > 0 && hour.counts.map((v, i) => v > 0 && (
        <rect key={i} x={i * bw + bw * 0.15} width={bw * 0.7} y={h - 1 - Math.max(2, (v / hour.peak) * (h - 3))} height={Math.max(2, (v / hour.peak) * (h - 3))}
          data-old={i < fresh || undefined} />
      ))}
    </svg>
  )
}

/** The hour in full, opened from the strip's sparkline, the chips' line or the matrix's. */
export function HourChart({ hour }: { hour: SubagentHour }) {
  return (
    <div data-hero-hour className="grid min-w-0 gap-px">
      <MinuteBars hour={hour} h={22} />
      <Axis />
    </div>
  )
}

/** "peak 4 at 12:22", or the peak alone when no minute is known. */
function peakWords(hour: SubagentHour): string {
  const at = peakMinute(hour)
  return `peak ${hour.peak}${at !== undefined ? ` at ${clockTime(at)}` : ''}`
}

/**
 * V1, the strip: one line. The working subagents' faces big, in colour,
 * breathing (still under prefers-reduced-motion), the finished small and
 * grey, *+N* past what fits; *1 working · peak 4*; the hour as an 80px
 * sparkline at the right, *peak 4 at 12:22* on hover, a click opens the full
 * chart under the line and a second folds it. Each face opens its subagent.
 */
export function SubagentStripLine({ subs, count, chips, more, onChip }: { subs: SubagentsNow; count: number; chips: SubagentChip[]; more: number; onChip: (id: string) => void }) {
  const look = useSubagentLook()
  const [d] = useFaceDefault()
  const [open, setOpen] = useState(false)
  const hour = subs.hour
  const busy = chips.filter((c) => c.state !== 'done')
  const working = busy.slice(0, STRIP_WORKING)
  const workingMore = busy.length - working.length + more
  const done = chips.filter((c) => c.state === 'done').slice(0, STRIP_DONE)
  const doneMore = Math.max(0, subs.finished - done.length)
  const peak = hour && hour.peak > 0 ? peakWords(hour) : ''
  return (
    <div data-hero-strip data-look="strip" className="grid min-w-0 gap-1">
      <div className="flex min-h-[28px] min-w-0 items-center gap-2">
        <span role="group" aria-label={`Subagents${workingMore > 0 ? `, and ${workingMore} more working` : ''}`} className="flex min-w-0 items-center gap-[3px]">
          {working.map((c, i) => (
            <button key={c.id} type="button" title={c.label} aria-label={`${c.label}. Open`} data-strip-face={c.id} data-state={c.state} onClick={() => onChip(c.id)}
              className="grid shrink-0 place-items-center rounded-full outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
              <span className="cockpit-subface-breathe" style={{ animationDelay: `${(i % 4) * 0.4}s` }}><SubFace face={subagentFace(c.id, d)} size={24} /></span>
            </button>
          ))}
          {workingMore > 0 && <span className="num shrink-0 text-[11px] text-fg-muted" title={`${workingMore} more working`}>+{workingMore}</span>}
          {done.map((c) => (
            <button key={c.id} type="button" title={c.label} aria-label={`${c.label}. Open`} data-strip-done={c.id} onClick={() => onChip(c.id)}
              className="cockpit-subface-done grid shrink-0 place-items-center rounded-full outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
              <SubFace face={subagentFace(c.id, d)} size={14} />
            </button>
          ))}
          {doneMore > 0 && <span data-strip-finished className="num shrink-0 text-[10.5px] text-fg-faint" title={`${doneMore} more finished lately`}>+{doneMore}</span>}
        </span>
        <span data-hero-count className="shrink-0 whitespace-nowrap text-[11px] text-fg-muted" title={`${subagents(count)} working${peak ? `; ${peak}, the most at once in a minute of the last hour` : ''}`}>
          {subagentSummary(count, hour)}
        </span>
        <span className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1">
          {hour && (
            <button type="button" data-hero-spark aria-expanded={open} title={peak || 'No subagents in the last hour'}
              aria-label={`The last hour of subagents${peak ? `, ${peak}` : ''}. ${open ? 'Hide' : 'Show'} the chart`}
              onClick={() => setOpen((v) => !v)}
              className="cockpit-subspark grid h-[20px] min-w-[32px] max-w-[84px] flex-1 place-items-center rounded-[4px] px-0.5 outline-none hover:bg-[var(--app-row-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
              <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true" className="block w-full" style={{ height: SPARK_H }}>
                <line className="base" x1="0" x2={SPARK_W} y1={SPARK_H - 0.5} y2={SPARK_H - 0.5} />
                {hour.peak > 0 && <polyline points={sparkPoints(hour.counts, hour.peak, SPARK_W, SPARK_H)} />}
              </svg>
            </button>
          )}
          <LookSwitch look={look} />
        </span>
      </div>
      {open && hour && <HourChart hour={hour} />}
    </div>
  )
}

/**
 * V2, the default: the chips are the faces (drawn by the caller, passed as
 * `chips`), *1 working · peak 4* beside them; a click on it opens the hour's
 * chart under the row and a second folds it. No frame: next to nothing over
 * the chip row's own height.
 */
export function SubagentChipsLine({ subs, count, chips }: { subs: SubagentsNow; count: number; chips: ReactNode }) {
  const look = useSubagentLook()
  const [open, setOpen] = useState(false)
  const hour = subs.hour
  const peak = hour && hour.peak > 0 ? peakWords(hour) : ''
  const text = subagentSummary(count, hour)
  return (
    <div data-hero-chipline data-look="chips" className="grid min-w-0 gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {chips}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {hour ? (
            <button type="button" data-hero-count aria-expanded={open} onClick={() => setOpen((v) => !v)}
              title={`${subagents(count)} working${peak ? `; ${peak}, the most at once in a minute of the last hour` : ''}. ${open ? 'Hide' : 'Show'} the last hour`}
              className="whitespace-nowrap rounded-[4px] px-0.5 text-[11px] leading-[18px] text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
              {text}
            </button>
          ) : (
            <span data-hero-count className="whitespace-nowrap text-[11px] leading-[18px] text-fg-muted" title={`${subagents(count)} working`}>{text}</span>
          )}
          <LookSwitch look={look} />
        </span>
      </div>
      {open && hour && <HourChart hour={hour} />}
    </div>
  )
}

/**
 * The matrix (the default look): the subagents' faces in a grid of four
 * columns beside the agent's large tile, which the caller draws. The working
 * (and the waiting) in colour and breathing gently, still under
 * prefers-reduced-motion; the recently finished grey and faded; past eight,
 * a *+N* tile for the working left out. Each face opens its subagent, as a
 * chip does. Under the grid, shown on hover, when a key moves into it, or
 * while the chart is open: *1 working · peak 4*, whose click opens the
 * hour's chart under the hero's row (the caller draws it from `open`), and
 * the three dots. Nothing else: the picture is the faces.
 */
export function SubagentMatrix({ subs, count, chips, more, open, onToggle, onChip }: { subs: SubagentsNow; count: number; chips: SubagentChip[]; more: number; open: boolean; onToggle: () => void; onChip: (id: string) => void }) {
  const look = useSubagentLook()
  const [d] = useFaceDefault()
  const hour = subs.hour
  const peak = hour && hour.peak > 0 ? peakWords(hour) : ''
  const busy = chips.filter((c) => c.state !== 'done').length
  const finished = chips.length - busy
  const said = [`${busy + more} working`, finished > 0 ? `${finished} finished lately` : '', peak].filter(Boolean).join(' · ')
  return (
    <div data-hero-matrix data-look="matrix" className="group/matrix grid min-w-0 content-start gap-1">
      <div role="group" aria-label={`Subagents${more > 0 ? `, and ${more} more working` : ''}`} title={said}
        className="grid w-max grid-cols-[repeat(4,24px)] gap-[3px]">
        {chips.map((c, i) => (
          <button key={c.id} type="button" title={c.label} aria-label={`${c.label}. Open`} data-matrix-face={c.id} data-state={c.state}
            onClick={() => onChip(c.id)}
            className="cockpit-matrix-face grid h-[24px] w-[24px] place-items-center rounded-full outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
            <span className={c.state === 'done' ? 'cockpit-subface-done' : 'cockpit-subface-breathe'} style={c.state === 'done' ? undefined : { animationDelay: `${(i % 4) * 0.4}s` }}>
              <SubFace face={subagentFace(c.id, d)} size={22} />
            </span>
          </button>
        ))}
        {more > 0 && (
          <span data-matrix-more title={`${more} more working`}
            className="num grid h-[24px] w-[24px] place-items-center rounded-[6px] bg-[var(--app-row-hover)] text-[10px] font-medium text-fg-muted">+{more}</span>
        )}
      </div>
      <div data-matrix-controls data-open={open || undefined}
        className="flex min-w-0 items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/matrix:opacity-100 data-[open]:opacity-100">
        {hour ? (
          <button type="button" data-hero-count aria-expanded={open} onClick={onToggle}
            title={`${subagents(count)} working${peak ? `; ${peak}, the most at once in a minute of the last hour` : ''}. ${open ? 'Hide' : 'Show'} the last hour`}
            className="whitespace-nowrap rounded-[4px] px-0.5 text-[10.5px] leading-[14px] text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
            {subagentSummary(count, hour)}
          </button>
        ) : (
          <span data-hero-count className="whitespace-nowrap text-[10.5px] leading-[14px] text-fg-muted" title={`${subagents(count)} working`}>{subagentSummary(count, hour)}</span>
        )}
        <LookSwitch look={look} />
      </div>
    </div>
  )
}
