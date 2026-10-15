/**
 * The sidebar's Second Brain block (ADR-063), below the projects: the owner's
 * "collapsible block on the left where my second brain is constantly being
 * built" (translated). A small graph of the newest thirty memories, where a
 * new one drops in as it is kept (components/BrainGraphCanvas), the three
 * newest titles and the count. A title or a dot opens it on `#/brain`.
 *
 * Before there is anything to show it is a banner, not a bare zero (the owner
 * called the old two faint lines "very sloppily done", translated): a faint
 * graph breathing, the one line on what it is, *Start building* and *How it
 * works*. *Start building* opens the consent in place — what is read, by
 * whose claude, where, the daily limit, and where it goes (rule 4) — and only
 * its *Turn on* sends the same PUT /v1/brain/settings as Settings. Once on
 * and still empty, the banner says what it is doing instead.
 *
 * Folds like the footer and remembers it; unfolded by default, for everyone
 * — Second Brain is free (owner decision, 2026-10-14). *How it works* opens
 * a short explainer with a way into the Second Brain screen.
 */
import { useState, type ReactNode } from 'react'
import { api, errText, type BrainAutoStatus } from '@/lib/api'
import { BRAIN_TAGLINE, isEntity, useBrainGraph, useBrainStatus } from '@/lib/brain'
import { keys } from '@/lib/appkeys'
import { BrainGraphCanvas } from './BrainGraphCanvas'
import { BRAIN_DISCLOSURE, limitLabel } from './BrainAutoSetting'
import { ChevronIcon } from './AppIcons'
import { BrainGlyph } from './BrainDrop'
import { SecondBrainModal } from './SecondBrainModal'

const FOLD_KEY = 'caprock.app.brain-fold'
/** What *Turn on* reads first: the same past month as Settings' backfill. */
const BACKFILL_DAYS = 30
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
  const { status, reload } = useBrainStatus()
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
  const auto = status.auto
  const howLink = (
    <button type="button" onClick={() => setHow(true)} className="justify-self-start px-1.5 text-[11.5px] text-fg-faint hover:text-fg hover:underline">
      How it works
    </button>
  )
  return (
    <section className="mt-3 border-t border-[var(--app-hairline)] pt-1" aria-label="Second Brain" data-brain-sidebar>
      <div className="flex h-[28px] items-center gap-1.5 px-2 pt-1.5">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <h2 className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-faint">
            <BrainGlyph size={12} className="shrink-0" />
            <span className="truncate">Second Brain</span>
          </h2>
          {auto?.enabled && <span className="shrink-0 text-[10.5px] text-fg-faint" title="Built from your finished sessions">· building</span>}
        </button>
        {status.memories > 0 && (
          <button
            type="button"
            onClick={() => onOpen('#/brain')}
            className="num text-[11.5px] text-fg-faint hover:text-fg"
            title={`${status.memories} ${status.memories === 1 ? 'memory' : 'memories'} — open Second Brain`}
          >
            {status.memories}
          </button>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-label={open ? 'Fold Second Brain' : 'Unfold Second Brain'}
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
              <p className="px-1.5 text-[11.5px] leading-snug text-fg-faint" data-brain-tagline>{BRAIN_TAGLINE}</p>
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
              {auto && !auto.on ? <StartBuilding auto={auto} onDone={reload} howLink={howLink} compact /> : howLink}
            </>
          ) : graph ? (
            <Banner auto={auto} onDone={reload} howLink={howLink} />
          ) : null}
        </div>
      )}
      {how && <SecondBrainModal onOpen={() => onOpen('#/brain')} onClose={() => setHow(false)} />}
    </section>
  )
}

/**
 * The empty block: a faint graph, the line on what it is, and either the way
 * to start (off, or never asked) or what it is doing (on, nothing kept yet).
 */
function Banner({ auto, onDone, howLink }: { auto?: BrainAutoStatus; onDone: () => void; howLink: ReactNode }) {
  const on = !!auto?.on
  return (
    <div
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 rounded-[8px] border border-[var(--app-hairline)] bg-[var(--app-row-hover)] px-1 pb-2 pt-1.5"
      data-brain-banner={on ? 'on' : 'off'}
    >
      <GhostGraph />
      <p className="px-1.5 text-[12px] font-medium leading-snug text-fg" data-brain-tagline>{BRAIN_TAGLINE}</p>
      {on && auto ? (
        <>
          <Progress auto={auto} />
          {howLink}
        </>
      ) : (
        <>
          {auto ? (
            <StartBuilding auto={auto} onDone={onDone} howLink={howLink} />
          ) : (
            <>
              <p className="px-1.5 text-[11.5px] leading-snug text-fg-muted">Drop an answer in from Memory or a chat, or {keys('⇧⌘H')}.</p>
              {howLink}
            </>
          )}
          <p className="px-1.5 text-[10.5px] text-fg-faint">Local · your own Claude · free</p>
        </>
      )}
    </div>
  )
}

/**
 * *Start building*, then the consent in place: one click to ask, one to say
 * yes. Nothing is sent before *Turn on* (rule 4); without claude there is no
 * button, only why.
 */
function StartBuilding({ auto, onDone, howLink, compact }: { auto: BrainAutoStatus; onDone: () => void; howLink: ReactNode; compact?: boolean }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const turnOn = () => {
    setErr('')
    setBusy(true)
    // Turning on reads only sessions that end after the yes; the consent
    // also promises the last 30 days, so the backfill follows it at once.
    api.brainSettings({ auto: true })
      .then(() => api.brainBackfill(BACKFILL_DAYS, true))
      .then(
        () => { setBusy(false); setAsking(false); onDone() },
        (e: unknown) => { setBusy(false); setErr(errText(e)); onDone() },
      )
  }
  if (!asking) {
    return (
      <div className={`flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 ${compact ? '' : 'px-1.5'}`}>
        <button
          type="button"
          onClick={() => setAsking(true)}
          className={compact
            ? 'px-1.5 text-[11.5px] text-accent hover:underline'
            : 'mr-1 rounded-[6px] bg-accent px-2.5 py-1 text-[12px] font-medium text-panel hover:bg-accent-strong'}
        >
          {compact ? 'Build it automatically' : 'Start building'}
        </button>
        {howLink}
      </div>
    )
  }
  return (
    <div
      ref={(el) => el?.scrollIntoView?.({ block: 'nearest' })}
      className="mx-0.5 grid min-w-0 gap-1.5 rounded-[6px] border border-[var(--app-hairline)] bg-panel p-2 text-[11.5px] leading-snug text-fg-muted"
      data-brain-sidebar-consent
    >
      <p className="text-fg">
        Your own <span className="mono">claude</span> ({auto.model}) reads each finished session on this computer,
        starting with your last {BACKFILL_DAYS} days — up to <span className="mono">{limitLabel(auto.daily_tokens)}</span> tokens a day.
      </p>
      <p>{BRAIN_DISCLOSURE} Off any time in Settings → Second Brain.</p>
      {auto.claude_found ? (
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy} onClick={turnOn} className="rounded-[6px] bg-accent px-2.5 py-1 text-[12px] font-medium text-panel hover:bg-accent-strong disabled:opacity-50">
            Turn on
          </button>
          <button type="button" disabled={busy} onClick={() => setAsking(false)} className="text-[11.5px] text-fg-faint hover:text-fg">
            Not now
          </button>
        </div>
      ) : (
        <>
          <p className="text-warn">
            Claude Code was not found, so nothing can be read. Install it, or put <span className="mono">claude</span> on the PATH Caprock started with.
          </p>
          <button type="button" onClick={() => setAsking(false)} className="justify-self-start text-[11.5px] text-fg-faint hover:text-fg">
            Close
          </button>
        </>
      )}
      {err && <p role="alert" className="text-danger">{err}</p>}
    </div>
  )
}

/** On, and nothing kept yet: what it is doing, from BrainAutoStatus as it is. */
function Progress({ auto }: { auto: BrainAutoStatus }) {
  // `next_wake` (unix ms) is newer than this screen's type; a daemon without it says nothing.
  const nextWake = (auto as BrainAutoStatus & { next_wake?: number }).next_wake
  const mins = nextWake && nextWake > Date.now() ? Math.max(1, Math.round((nextWake - Date.now()) / 60_000)) : 0
  const line = !auto.claude_found
    ? ''
    : auto.running
      ? 'Reading your recent sessions…'
      : auto.pending > 0
        ? `${auto.pending} session${auto.pending === 1 ? '' : 's'} waiting · first memories ${mins ? `in about ${mins} min` : 'in a few minutes'}`
        : 'On · a session is read once it has been quiet for ten minutes'
  return (
    <div className="grid min-w-0 gap-0.5 px-1.5 text-[11.5px] leading-snug" data-brain-progress>
      {line && (
        <p className="flex min-w-0 items-center gap-1.5 text-fg-muted">
          <span className={`h-[6px] w-[6px] shrink-0 rounded-full bg-accent ${auto.running ? 'graph-breathe' : 'opacity-60'}`} aria-hidden />
          <span className="min-w-0">{line}</span>
        </p>
      )}
      {!auto.claude_found && (
        <p className="text-warn">Claude Code was not found, so nothing is read. Install it, or put <span className="mono">claude</span> on the PATH Caprock started with.</p>
      )}
      {auto.last_error && <p className="truncate text-warn" title={auto.last_error}>Last problem: {auto.last_error}</p>}
    </div>
  )
}

/** A faint graph in the kinds' colours; its dots breathe slowly, and hold still under prefers-reduced-motion (`.graph-breathe`). */
const GHOST_NODES: [number, number, number, string][] = [
  [100, 30, 5, 'var(--brain-idea)'], [58, 18, 3.5, 'var(--brain-decision)'], [146, 16, 3.5, 'var(--brain-finding)'],
  [40, 44, 3, 'var(--brain-topic)'], [160, 46, 3.5, 'var(--brain-question)'], [76, 50, 3, 'var(--brain-finding)'],
  [124, 52, 3, 'var(--brain-decision)'], [18, 24, 2.5, 'var(--brain-topic)'], [184, 26, 2.5, 'var(--brain-idea)'],
]
const GHOST_LINKS: [number, number][] = [[0, 1], [0, 2], [0, 5], [0, 6], [1, 3], [1, 7], [2, 4], [2, 8], [4, 6], [3, 5]]

function GhostGraph() {
  return (
    <svg viewBox="0 0 200 64" className="block h-[52px] w-full" aria-hidden="true" data-brain-ghost>
      <g opacity="0.5">
        {GHOST_LINKS.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={GHOST_NODES[a]![0]} y1={GHOST_NODES[a]![1]} x2={GHOST_NODES[b]![0]} y2={GHOST_NODES[b]![1]}
            stroke="var(--color-border-strong)" strokeWidth="0.8" />
        ))}
      </g>
      <g opacity="0.6">
        {GHOST_NODES.map(([x, y, r, c], i) => (
          <circle key={i} cx={x} cy={y} r={r} fill={c} className="graph-breathe"
            style={{ animationDuration: `${4 + (i % 3)}s`, animationDelay: `${-i * 0.7}s` }} />
        ))}
      </g>
    </svg>
  )
}
