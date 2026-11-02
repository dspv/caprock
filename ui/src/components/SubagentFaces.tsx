/**
 * The hero's subagent frame, drawn with the brand characters (.ai/04-ui.md §
 * Inspector, the subagent chart; lib/subagentfaces for the arithmetic).
 * Three looks the viewer switches between from the frame's corner, the chart
 * of faces by default:
 *
 * - **Chart of faces**: the hour in twelve five-minute columns, each a stack
 *   of faces as tall as the most subagents at once in it, the older columns
 *   dimmed; past a peak of six one face stands for several (*1 face = 2*).
 * - **Crew**: one face per working subagent, bobbing gently, the latest
 *   finished smaller and faded, the types as chips, the hour as bars.
 * - **Numbers**: the crowd large, *N working now* big, the peak at the right,
 *   the hour as amber bars.
 *
 * The faces are the one chosen for Claude in Settings, or picked from its
 * random pool by a stable key (the subagent's id, the column and place),
 * so nothing reshuffles on a re-render.
 */
import { Fragment, type ReactNode } from 'react'
import type { SubagentsNow, SubagentHour } from '@/lib/api'
import type { Face, FaceDefault } from '@/lib/faces'
import { useFaceDefault } from '@/lib/faces'
import { Body } from './Characters'
import {
  BUCKETS, BUCKET_MINUTES, SUBAGENT_LOOKS, clockTime, faceBuckets, faceScale, peakMinute, setSubagentLook, stackHeight, subagentFace, useSubagentLook,
  type SubagentLook,
} from '@/lib/subagentfaces'

type Kind = { type: string; count: number; first: string }

/** How many of the newest columns (and their minutes) are drawn in full; the older are dimmed. */
const FRESH_BUCKETS = 2
/** The most working faces the crew draws before "+N". */
const CREW_MAX = 8

/** One character's face, cropped tighter than its 80px scene so a small one still reads. */
function Mini({ face, size, who = 'lead', className }: { face?: Face; size?: number; who?: 'lead' | 'crowd'; className?: string }) {
  return (
    <svg viewBox="6 8 68 68" aria-hidden="true" className={className} data-face={who === 'lead' ? face : who}
      style={size ? { width: size, height: size, flex: 'none', display: 'block' } : { flex: 'none', display: 'block' }}>
      <Body who={who} face={face} />
    </svg>
  )
}

function subagents(n: number): string {
  return `${n} ${n === 1 ? 'subagent' : 'subagents'}`
}

function Axis() {
  return (
    <div data-hero-axis aria-hidden="true" className="num flex justify-between text-[10px] leading-[14px] text-fg-faint">
      <span>1h ago</span><span>30m</span><span>now</span>
    </div>
  )
}

/** The three looks as three small dots in the frame's corner. */
function LookSwitch({ look }: { look: SubagentLook }) {
  return (
    <span role="group" aria-label="How the subagents are drawn" data-subagent-looks className="absolute right-1 top-[3px] flex items-center">
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

/** The types as words, comma-separated, each opening the first of its kind. */
function KindWords({ kinds, onChip }: { kinds: Kind[]; onChip: (id: string) => void }) {
  return (
    <span data-hero-kinds className="min-w-0">
      {kinds.map((k, i) => (
        <Fragment key={k.type}>
          {i > 0 && ', '}
          <button type="button" data-hero-kind={k.type} onClick={() => onChip(k.first)}
            title={`${k.count} ${k.type} working. Open`}
            className="rounded-[4px] text-fg-muted underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]">
            {k.count} {k.type}
          </button>
        </Fragment>
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
          <Mini face={subagentFace(k.first, d)} size={14} />
          <span className="truncate"><span className="num">{k.count}</span> {k.type}</span>
        </button>
      ))}
    </span>
  )
}

/** The hour's minutes as bars, scaled to the peak, the last ten minutes in full. */
function MinuteBars({ hour, tone }: { hour: SubagentHour; tone: 'ok' | 'amber' }) {
  const W = 300
  const H = 22
  const n = Math.max(1, hour.counts.length)
  const bw = W / n
  const fresh = n - FRESH_BUCKETS * BUCKET_MINUTES
  return (
    <svg data-hero-bars data-tone={tone} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" data-empty={hour.peak === 0 || undefined}
      aria-label={hour.peak > 0 ? `Subagents at work each minute of the last hour, at most ${hour.peak} at once` : 'No subagents in the last hour'}
      className="cockpit-subbars block h-[22px] w-full">
      <line className="base" x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} />
      {hour.peak > 0 && hour.counts.map((v, i) => v > 0 && (
        <rect key={i} x={i * bw + bw * 0.15} width={bw * 0.7} y={H - 1 - Math.max(2, (v / hour.peak) * (H - 3))} height={Math.max(2, (v / hour.peak) * (H - 3))}
          data-old={i < fresh || undefined} />
      ))}
    </svg>
  )
}

/** V2, the default: the hour as twelve columns of stacked faces. */
function FaceChart({ hour, d }: { hour: SubagentHour; d: FaceDefault }) {
  const buckets = faceBuckets(hour)
  const scale = faceScale(hour.peak)
  const step = hour.step_ms > 0 ? hour.step_ms : 60_000
  return (
    <div data-hero-faces role="img"
      aria-label={hour.peak > 0 ? `Subagents at work in each five minutes of the last hour, at most ${hour.peak} at once` : 'No subagents in the last hour'}
      className="flex min-h-[8px] items-end gap-[2px] border-b border-[var(--app-hairline)] pb-[1px]">
      {buckets.map((b, j) => {
        const stack = stackHeight(b.most, scale)
        return (
          <div key={b.start} data-bucket={j} data-most={b.most} data-dim={j < BUCKETS - FRESH_BUCKETS || undefined}
            title={b.most > 0 ? `${clockTime(b.start)}–${clockTime(b.start + step * BUCKET_MINUTES)}: at most ${b.most} at once` : undefined}
            className="cockpit-subcol flex min-w-0 flex-1 flex-col-reverse items-center">
            {Array.from({ length: stack }, (_, k) => (
              <span key={k} className="cockpit-subcol-face block aspect-square w-full max-w-[18px]">
                <Mini face={subagentFace(`${b.start}:${k}`, d)} className="h-full w-full" />
              </span>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** V1: who is at work now, as faces. */
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
          <Mini face={subagentFace(a.agent_id, d)} size={24} />
        </span>
      ))}
      {more > 0 && <span className="num self-center text-[11px] text-fg-muted">+{more}</span>}
      {done.map((x) => (
        <span key={x.agent_id} data-crew-done={x.agent_id} title={x.agent_type ? `${x.agent_type}, finished` : 'Finished'} className="cockpit-subface-done">
          <Mini face={subagentFace(x.agent_id, d)} size={17} />
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
 * The frame beside the headline figure: how many subagents work now, of
 * which types, the most at once in the last hour, and the hour drawn in the
 * viewer's look. With none in the hour, one quiet line and no faces; from a
 * daemon that sends no hour, *no subagents running*.
 */
export function SubagentChart({ subs, count, kinds, onChip }: { subs: SubagentsNow; count: number; kinds: Kind[]; onChip: (id: string) => void }) {
  const look = useSubagentLook()
  const [d] = useFaceDefault()
  const hour = subs.hour
  const quiet = count === 0 && (!hour || hour.peak === 0)
  const frame = (children: ReactNode) => (
    <div data-hero-subs data-look={quiet ? undefined : look}
      className="cockpit-subframe relative grid min-w-0 content-start gap-1 rounded-[7px] bg-[color-mix(in_srgb,var(--color-fg)_3%,transparent)] px-2 pb-1 pt-1 shadow-[inset_0_0_0_1px_var(--app-hairline)]">
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
  const at = hour ? peakMinute(hour) : undefined
  const countLine = (
    <span data-hero-count className="whitespace-nowrap font-semibold text-fg" title={`${subagents(count)} working`}>{subagents(count)}</span>
  )
  if (look === 'numbers') {
    return frame(
      <>
        <div className="flex min-w-0 items-center gap-2 pr-[30px]">
          <Mini who="crowd" size={40} className="shrink-0" />
          <div className="grid min-w-0 leading-none">
            <span data-hero-count className="num text-[24px] font-semibold leading-[26px] text-[var(--subfaces-amber)]" title={`${subagents(count)} working`}>{count}</span>
            <span className="text-[11px] leading-[14px] text-fg-muted">working now</span>
          </div>
          {hour && hour.peak > 0 && (
            <div data-hero-peak className="ml-auto grid shrink-0 text-right leading-none" title={at ? `The most at work at once in a minute of the last hour, at ${clockTime(at)}` : undefined}>
              <span className="num text-[16px] font-semibold leading-[20px] text-fg">{hour.peak}</span>
              <span className="whitespace-nowrap text-[10.5px] leading-[14px] text-fg-faint">peak · 1h</span>
            </div>
          )}
        </div>
        {kinds.length > 0 && <KindChips kinds={kinds} onChip={onChip} d={d} />}
        {hour && <><MinuteBars hour={hour} tone="amber" /><Axis /></>}
      </>,
    )
  }
  if (look === 'crew') {
    return frame(
      <>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 pr-[30px] text-[11px] leading-[16px] text-fg-muted">
          {countLine}
          {hour && hour.peak > 0 && <span data-hero-peak className="num ml-auto whitespace-nowrap text-[10.5px] text-fg-faint" title="The most at work at once in a minute of the last hour">peak {hour.peak} · 1h</span>}
        </div>
        <Crew subs={subs} d={d} />
        {kinds.length > 0 && <KindChips kinds={kinds} onChip={onChip} d={d} />}
        {hour && <><MinuteBars hour={hour} tone="ok" /><Axis /></>}
      </>,
    )
  }
  const scale = hour ? faceScale(hour.peak) : 1
  return frame(
    <>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 pr-[30px] text-[11px] leading-[16px] text-fg-muted">
        {countLine}
        {hour && hour.peak > 0 && (
          <span data-hero-peak className="num ml-auto whitespace-nowrap text-[10.5px] text-fg-faint" title="The most at work at once in a minute of the last hour, and when">
            peak {hour.peak}{at !== undefined ? ` at ${clockTime(at)}` : ''}
          </span>
        )}
      </div>
      {(kinds.length > 0 || scale > 1) && (
        <div className="flex min-w-0 items-baseline gap-x-1.5 text-[11px] leading-[16px] text-fg-muted">
          {kinds.length > 0 && <KindWords kinds={kinds} onChip={onChip} />}
          {scale > 1 && <span data-face-scale className="num ml-auto shrink-0 whitespace-nowrap text-[10px] text-fg-faint" title={`Each face stands for ${scale} subagents`}>1 face = {scale}</span>}
        </div>
      )}
      {hour && <><FaceChart hour={hour} d={d} /><Axis /></>}
    </>,
  )
}
