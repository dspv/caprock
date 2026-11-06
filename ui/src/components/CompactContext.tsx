/**
 * Compact context (ADR-085): the action in the cockpit's Context section.
 *
 * Full look: a button, what usually stays and where that figure comes from,
 * and after a compaction its measured before → after. Collapsed look: a
 * small icon at the end of the line, from 60% full. Both hidden under 100k
 * tokens of context, except the after line, which stays to say what the
 * press did. No confirmation and no field: one click types Claude Code's
 * own /compact (never /clear) into a session Caprock started, at once at
 * its prompt or when its turn ends. A session someone else's terminal
 * holds is never typed into (rule 7): the command to type there, and
 * Continue here.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { api, errText, type Compaction, type CompactionEstimate, type CompactionView, type SessionSummary } from '@/lib/api'
import { everyWhileVisible } from '@/lib/visible'
import { useCanControl } from '@/lib/useCanControl'
import { useNow } from '@/lib/useNow'
import { setLook } from '@/lib/cockpitlooks'
import { COMPACT_COMMAND, approxUSD, compactIcon, compactInfo, compactLine, compactOffer, compactPhase, compactingLine, fmtElapsed, keptLine, savingOf, savingsPath, type CompactOffer, type CompactPhase, type CompactPress } from '@/lib/compact'
import { ContinueSession } from './ContinueSession'

/** How often the view is read again while a press waits for its boundary. */
const WATCH_POLL_MS = 3_000

export interface CompactState {
  offer: CompactOffer
  icon: boolean
  view?: CompactionView
  phase: CompactPhase
  error: string
  press: () => void
}

/**
 * The session's compaction as the daemon reads it — on open, whenever the
 * context's size changes, when the session starts compacting, and every
 * three seconds while a compaction or a press waits for its boundary — and
 * the press itself.
 */
export function useCompact(s: SessionSummary): CompactState {
  const canControl = useCanControl()
  const offer = compactOffer(s, canControl)
  const claude = !s.agent || s.agent === 'claude'
  const [view, setView] = useState<CompactionView | undefined>(undefined)
  const [pressed, setPressed] = useState<CompactPress | undefined>(undefined)
  const [error, setError] = useState('')
  const id = s.session_id
  const load = useCallback(() => {
    api.compaction(id).then((v) => { if (v && v.session_id === id) setView(v) }).catch(() => { /* the line stays as it was */ })
  }, [id])
  useEffect(() => { setView(undefined); setPressed(undefined); setError('') }, [id])
  // A compaction started anywhere — /compact typed in the terminal, or
  // Claude Code's own when it ran out of room — narrates as "compacting
  // context" from its PreCompact hook: read the view then, and the watch
  // below follows it to the boundary.
  const compacting = s.activity?.phrase === 'compacting context'
  useEffect(() => { if (claude) load() }, [claude, load, s.context?.tokens, compacting])
  const phase = compactPhase(view, pressed)
  const watching = phase.kind === 'queued' || phase.kind === 'running'
  useEffect(() => {
    if (!watching) return
    return everyWhileVisible(load, WATCH_POLL_MS)
  }, [watching, load])
  const press = () => {
    if (watching) return
    setError('')
    const at = Date.now()
    api.compact(id)
      .then((r) => { setPressed({ at, sent: r.sent }); load() })
      .catch((e) => { setError(errText(e)); load() })
  }
  return { offer, icon: compactIcon(s, canControl), view, phase, error, press }
}

/** Compactions whose ghost has shrunk on this page already: it plays once. */
const ghostsPlayed = new Set<string>()

/**
 * The Context meter's bar. The empty track is tinted faintly by the zones
 * the fill turns warn (60%) and danger (85%) in, and the quarter marks read
 * the same over fill and track. While a compaction runs, stripes move over
 * the fill — Claude Code reports no progress, so nothing measures it. After
 * one, `ghost` is the fill before it, faint, shrinking once to the new one.
 */
export function ContextBar({ h, pct, tone, running, ghost }: {
  h: string
  pct: number
  tone: 'ok' | 'warn' | 'danger'
  running: boolean
  /** The compaction's key and the fill before it, percent. */
  ghost?: { id: string; from: number }
}) {
  const width = Math.max(pct, 1.5)
  return (
    <div className={`cockpit-track cockpit-ctx-track relative ${h} overflow-hidden rounded-full`} role="meter" aria-label="Context used"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-busy={running || undefined} data-compacting={running || undefined}>
      {ghost && ghost.from > width && <ContextGhost key={ghost.id} id={ghost.id} from={ghost.from} to={width} />}
      <div className="cockpit-fill relative h-full overflow-hidden rounded-full" data-tone={tone} style={{ width: `${width}%` }}>
        {running && <span aria-hidden className="cockpit-stripes absolute inset-0" />}
      </div>
      {[25, 50, 75].map((m) => <span key={m} aria-hidden className="cockpit-quarter absolute top-0 h-full w-px" style={{ left: `${m}%` }} />)}
    </div>
  )
}

function ContextGhost({ id, from, to }: { id: string; from: number; to: number }) {
  const [play] = useState(() => !ghostsPlayed.has(id))
  const [gone, setGone] = useState(false)
  useEffect(() => { ghostsPlayed.add(id) }, [id])
  if (!play || gone) return null
  return (
    <span aria-hidden data-ghost className="cockpit-ghost absolute inset-y-0 left-0 rounded-full"
      style={{ '--ghost-from': `${from}%`, '--ghost-to': `${to}%` } as CSSProperties}
      onAnimationEnd={() => setGone(true)} />
  )
}

/**
 * What runs instead of "% full" while a compaction does: *Compacting · 0:16
 * · usually ~1 min* (lib/compact compactingLine); `brief`, the collapsed
 * line's *compacting 0:16*.
 */
export function CompactingLine({ view, brief = false }: { view?: CompactionView; brief?: boolean }) {
  const now = useNow(1000)
  const since = view?.running ? view.running_since : undefined
  const text = brief ? `compacting${since ? ` ${fmtElapsed(now - since)}` : '…'}` : compactingLine(view, now)
  return <span data-compact="running" className="font-medium tabular-nums text-accent">{text}</span>
}

/** Two arrows meeting: the context pressed together. */
function CompactGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9.5 2.5v4h4M14 2l-4.5 4.5M6.5 13.5v-4h-4M2 14l4.5-4.5" />
    </svg>
  )
}

function phaseWords(p: CompactPhase): string {
  switch (p.kind) {
    case 'queued': return 'Will compact when this turn ends'
    case 'running': return 'Compacting…'
    default: return ''
  }
}

/** The collapsed line's icon: press, or open the full look where the command is. */
export function CompactIcon({ c }: { c: CompactState }) {
  if (!c.icon) return null
  const kept = keptLine(c.view?.typical)
  const busy = c.phase.kind === 'queued' || c.phase.kind === 'running'
  const title = c.offer === 'press'
    ? busy ? phaseWords(c.phase) : `Compact context: Claude Code's ${COMPACT_COMMAND}, and the session carries on here. ${kept.text} (${kept.source}).`
    : `Compact context: Caprock does not type into a terminal it did not start. Open Context for the command.`
  return (
    <button type="button" aria-label="Compact context" title={c.error || title} disabled={busy}
      data-busy={busy || undefined}
      onClick={(e) => {
        e.stopPropagation()
        if (c.offer === 'press') c.press()
        else setLook('context', 'full')
      }}
      className={`grid size-[18px] shrink-0 place-items-center rounded-[5px] outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:cursor-default ${busy ? 'animate-pulse text-accent' : c.error ? 'text-danger' : 'text-fg-muted hover:text-fg'}`}>
      <CompactGlyph />
    </button>
  )
}

/** The ⓘ beside "~15% stays": what /compact is and how every figure is made. */
function InfoToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-label="About compacting and its estimates" aria-expanded={open} onClick={onToggle}
      className={`grid size-[15px] shrink-0 place-items-center rounded-full border font-serif text-[9.5px] font-semibold italic leading-none outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] ${open ? 'border-[var(--color-accent)] text-accent' : 'border-border-strong text-fg-faint hover:text-fg'}`}>
      i
    </button>
  )
}

function InfoPanel({ c, kept, last }: { c: CompactState; kept: { text: string; source: string }; last?: Compaction }) {
  return (
    <div className="grid gap-1.5 rounded-[8px] border border-border-strong bg-panel px-2.5 py-2 text-[11.5px] leading-snug text-fg-muted" data-compact="info">
      {compactInfo(kept, last, c.view?.estimate).map((p) => (
        <p key={p.lead}><b className="font-semibold text-fg">{p.lead}</b> — {p.text}</p>
      ))}
    </div>
  )
}

/** The savings since the compaction, drawn: a step at each call, flat while idle. */
function SavingsCurve({ est }: { est: CompactionEstimate }) {
  const W = 300, H = 20
  const d = savingsPath(est.series, W, H)
  return (
    <div className="flex min-w-0 items-center gap-2" data-compact="saved">
      <svg className="block h-5 min-w-0 flex-1" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`Saved since the compaction, by time: ${approxUSD(est.est_saved_usd)} over ${est.turns_after} calls`}>
        <path d={`${d} L${W} ${H} L0 ${H} Z`} fill="var(--color-ok)" opacity=".16" />
        <path d={d} fill="none" stroke="var(--color-ok)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="num shrink-0 whitespace-nowrap text-[11.5px] text-fg-muted">saved <span className="font-medium text-ok">{approxUSD(est.est_saved_usd)}</span></span>
    </div>
  )
}

/** The one line and its curve: the newest compaction, what it cost and has saved. */
function CompactResult({ c, after, fresh }: { c: CompactState; after: Compaction; fresh: boolean }) {
  const est = c.view?.estimate
  const saving = savingOf(after, est)
  const auto = after.trigger === 'auto'
  return (
    <>
      <div className={`num flex min-w-0 items-center gap-2 text-[11.5px] ${fresh ? 'text-fg' : 'text-fg-muted'}`} data-compact="result">
        <span title={auto ? 'Automatic: Claude Code ran out of room' : 'Manual: /compact'} aria-label={auto ? 'Automatic' : 'Manual'}
          className="grid h-[14px] min-w-[14px] shrink-0 place-items-center rounded-[4px] bg-panel-2 px-[3px] text-[9px] font-semibold text-fg-faint">{auto ? 'A' : 'M'}</span>
        <span className="min-w-0 truncate" title={compactLine(after, est)}>{compactLine(after, est)}</span>
      </div>
      {saving && <SavingsCurve est={saving} />}
    </>
  )
}

/** The full look's lines under the meter. */
export function CompactAction({ s, c }: { s: SessionSummary; c: CompactState }) {
  const [copied, setCopied] = useState(false)
  const [info, setInfo] = useState(false)
  const last = c.view?.last
  const done = c.phase.kind === 'done' ? c.phase.last : undefined
  const after = done ?? last
  const kept = keptLine(c.view?.typical)
  const afterLine = after ? <CompactResult c={c} after={after} fresh={!!done} /> : null
  if (c.offer === 'none') {
    if (!after) return null
    return (
      <div className="grid gap-1.5" data-compact="history">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 grid gap-1.5">{afterLine}</div>
          <InfoToggle open={info} onToggle={() => setInfo(!info)} />
        </div>
        {info && <InfoPanel c={c} kept={kept} last={after} />}
      </div>
    )
  }
  if (c.offer === 'type') {
    const copy = () => {
      void navigator.clipboard?.writeText(COMPACT_COMMAND).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})
    }
    return (
      <div className="grid gap-1.5" data-compact="type">
        <div className="flex min-w-0 items-start gap-2">
          <p className="min-w-0 flex-1 text-[11.5px] text-fg-muted">
            To compact, type <button type="button" onClick={copy} title="Copy" className="num rounded-[4px] bg-panel-2 px-1 text-fg hover:text-accent">{COMPACT_COMMAND}</button>
            {copied && <span className="ml-1 text-ok">copied</span>} in its terminal: Caprock does not type into a terminal it did not start. {kept.text}.
          </p>
          <InfoToggle open={info} onToggle={() => setInfo(!info)} />
        </div>
        {info && <InfoPanel c={c} kept={kept} last={after} />}
        {afterLine}
        {s.resume && <div><ContinueSession sessionID={s.session_id} cwd={s.cwd} live={s.status !== 'ended' && !s.detached} resume={s.resume} compact /></div>}
      </div>
    )
  }
  const busy = c.phase.kind === 'queued' || c.phase.kind === 'running'
  return (
    <div className="grid gap-1.5" data-compact="press">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button type="button" onClick={c.press} disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-[6px] border border-border-strong px-2 py-[3px] text-[12px] font-medium text-fg outline-none hover:border-[var(--color-accent)] hover:text-accent focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:cursor-default disabled:opacity-70 disabled:hover:border-border-strong disabled:hover:text-fg">
          <CompactGlyph />
          {busy ? phaseWords(c.phase) : 'Compact context'}
        </button>
        {!busy && <span className="text-[11.5px] text-fg-muted">{kept.text}</span>}
        <InfoToggle open={info} onToggle={() => setInfo(!info)} />
      </div>
      {c.error && <p role="alert" className="text-[11.5px] text-danger">{c.error}</p>}
      {info && <InfoPanel c={c} kept={kept} last={after} />}
      {afterLine}
    </div>
  )
}
