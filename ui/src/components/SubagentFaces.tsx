/**
 * The hero's subagents, drawn with the brand characters (.ai/04-ui.md §
 * Inspector, the subagent chart; lib/subagentfaces for the arithmetic).
 * Three looks the viewer switches between with three small dots, the faces
 * as chips by default (owner, 2026-11-06, translated: the old three were
 * "fun, but take far too much space"):
 *
 * - **Faces as chips**: no frame; the chips under the figures are the
 *   subagents' faces (SubagentStrip in Cockpit), *1 working · peak 4* beside
 *   them, a click on it opens the hour's chart under the row.
 * - **Strip**: one line, the working faces big and breathing, the finished
 *   small and grey, *1 working · peak 4*, and the hour as a sparkline whose
 *   click opens the full chart in place.
 * - **Crew**: the framed block beside the figures, one face per working
 *   subagent, the latest finished small and faded, the types as chips, the
 *   hour as bars — tightened from the 2026-10-31 frame.
 *
 * The faces are the one chosen for Claude in Settings, or picked from its
 * random pool by a stable key (the subagent's id), so nothing reshuffles on
 * a re-render.
 */
import { useState, type ReactNode } from 'react'
import type { SubagentsNow, SubagentHour } from '@/lib/api'
import type { SubagentChip } from '@/lib/cockpit'
import type { Face, FaceDefault } from '@/lib/faces'
import { useFaceDefault } from '@/lib/faces'
import { Body } from './Characters'
import {
  FRESH_MINUTES, SUBAGENT_LOOKS, clockTime, peakMinute, setSubagentLook, sparkPoints, subagentFace, subagentSummary, useSubagentLook,
  type SubagentLook,
} from '@/lib/subagentfaces'

type Kind = { type: string; count: number; first: string }

/** The most working faces the crew draws before "+N". */
const CREW_MAX = 8
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

function Axis({ tight }: { tight?: boolean }) {
  return (
    <div data-hero-axis aria-hidden="true" className={`num flex justify-between text-fg-faint ${tight ? 'text-[9.5px] leading-[11px]' : 'text-[10px] leading-[14px]'}`}>
      <span>1h ago</span><span>30m</span><span>now</span>
    </div>
  )
}

/** The three looks as three small dots: in the crew's corner, or at the end of the line. */
function LookSwitch({ look, inline }: { look: SubagentLook; inline?: boolean }) {
  return (
    <span role="group" aria-label="How the subagents are drawn" data-subagent-looks
      className={inline ? 'flex shrink-0 items-center' : 'absolute right-1 top-[1px] flex items-center'}>
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

/** The types as chips, each with a small face of its first subagent. */
function KindChips({ kinds, onChip, d }: { kinds: Kind[]; onChip: (id: string) => void; d: FaceDefault }) {
  return (
    <span data-hero-kinds className="flex min-w-0 flex-wrap gap-1">
      {kinds.map((k) => (
        <button key={k.type} type="button" data-hero-kind={k.type} onClick={() => onChip(k.first)}
          title={`${k.count} ${k.type} working. Open`}
          className="inline-flex min-w-0 items-center gap-1 rounded-full bg-[var(--app-row-hover)] py-px pl-[3px] pr-2 text-[11px] leading-[16px] text-fg-muted outline-none hover:text-fg focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
          <SubFace face={subagentFace(k.first, d)} size={14} />
          <span className="truncate"><span className="num">{k.count}</span> {k.type}</span>
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

/** The hour in full, opened from the strip's sparkline or the chips' line. */
function HourChart({ hour }: { hour: SubagentHour }) {
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
          <LookSwitch look={look} inline />
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
          <LookSwitch look={look} inline />
        </span>
      </div>
      {open && hour && <HourChart hour={hour} />}
    </div>
  )
}

/** The crew: who is at work now, as faces. */
function Crew({ subs, d }: { subs: SubagentsNow; d: FaceDefault }) {
  const shown = subs.working.slice(0, CREW_MAX)
  const more = subs.working.length - shown.length
  const done = (subs.recent ?? []).slice(0, 3)
  if (shown.length === 0 && done.length === 0 && subs.finished === 0) return null
  return (
    <div data-hero-crew className="flex min-w-0 flex-wrap items-end gap-x-1 gap-y-0.5">
      {shown.map((a, i) => (
        <span key={a.agent_id} data-crew-face={a.agent_id} title={a.agent_type ? `${a.agent_type}, working` : 'Working'}
          className="cockpit-subface-bob" style={{ animationDelay: `${(i % 4) * 0.35}s` }}>
          <SubFace face={subagentFace(a.agent_id, d)} size={24} />
        </span>
      ))}
      {more > 0 && <span className="num self-center text-[11px] text-fg-muted">+{more}</span>}
      {done.map((x) => (
        <span key={x.agent_id} data-crew-done={x.agent_id} title={x.agent_type ? `${x.agent_type}, finished` : 'Finished'} className="cockpit-subface-done">
          <SubFace face={subagentFace(x.agent_id, d)} size={17} />
        </span>
      ))}
      {subs.finished > 0 && (
        <span data-crew-finished className="self-center whitespace-nowrap pl-0.5 text-[11px] text-fg-faint" title="Subagents that finished lately">
          +<span className="num">{subs.finished}</span> finished
        </span>
      )}
    </div>
  )
}

/**
 * V3, the crew: the frame beside the headline figure — how many subagents
 * work now, the most at once in the last hour, the working as faces, the
 * types as chips, the hour as bars. With none in the hour, one quiet line;
 * from a daemon that sends no hour, *no subagents*.
 */
export function SubagentChart({ subs, count, kinds, onChip }: { subs: SubagentsNow; count: number; kinds: Kind[]; onChip: (id: string) => void }) {
  const look = useSubagentLook()
  const [d] = useFaceDefault()
  const hour = subs.hour
  const quiet = count === 0 && (!hour || hour.peak === 0)
  const frame = (children: ReactNode) => (
    <div data-hero-subs data-look={quiet ? undefined : 'crew'}
      className="cockpit-subframe relative grid min-w-0 content-start gap-0.5 rounded-[6px] bg-[color-mix(in_srgb,var(--color-fg)_3%,transparent)] px-1.5 py-0.5 shadow-[inset_0_0_0_1px_var(--app-hairline)]">
      {children}
      {!quiet && <LookSwitch look={look} />}
    </div>
  )
  if (quiet) {
    return frame(
      <>
        <span data-hero-nosubs className="truncate whitespace-nowrap text-[11px] leading-[16px] text-fg-faint" title={hour ? 'No subagents in the last hour' : undefined}>{hour ? 'no subagents · 1h' : 'no subagents'}</span>
        {hour && <div role="img" aria-label="No subagents in the last hour" className="h-px w-full self-end bg-[var(--app-hairline)]" />}
      </>,
    )
  }
  return frame(
    <>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 pr-[36px] text-[11px] leading-[15px] text-fg-muted">
        <span data-hero-count className="whitespace-nowrap font-semibold text-fg" title={`${subagents(count)} working`}>{subagents(count)}</span>
        {hour && hour.peak > 0 && <span data-hero-peak className="num ml-auto whitespace-nowrap text-[10.5px] text-fg-faint" title="The most at work at once in a minute of the last hour">peak {hour.peak} · 1h</span>}
      </div>
      <Crew subs={subs} d={d} />
      {kinds.length > 0 && <KindChips kinds={kinds} onChip={onChip} d={d} />}
      {hour && <div className="grid min-w-0 gap-px"><MinuteBars hour={hour} h={12} /><Axis tight /></div>}
    </>,
  )
}
