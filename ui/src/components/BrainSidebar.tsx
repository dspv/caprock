/**
 * The sidebar's Second Brain card (ADR-063), below the projects: the owner's
 * "collapsible block on the left where my second brain is constantly being
 * built" (translated).
 *
 * Unfolded, it is the living brain (BrainOrb): the memories as a slowly
 * turning cloud, the agents this user runs at its rim, sparks travelling
 * from them into it while the extraction works and a point lighting up as
 * each memory lands — and one quiet line of what it is doing, from the
 * daemon: "Extracting from acme-api", "Indexing 3 sessions", "Idle · 16
 * memories · updated 1m ago", "Paused", with a thin bar while it builds.
 * Folded, it is one row: a live dot, that same mode in words, and a figure
 * or two (the count, +N today) — what it does now first (owner, 2026-10-15:
 * "what it is doing right now matters more than the numbers"). The chevron
 * folds it, remembered in this browser.
 *
 * It sits under the list, above the sidebar's footer, never inside the
 * list's scroll (owner, 2026-10-15: with a long list of sessions the status
 * line under the orb was cut off by the footer). When the list and the card
 * do not both fit, the card gives way first — it shrinks twenty times as
 * readily as the list (`shrink-[20]`), and inside it only the orb does, from
 * 150px down to 64px — and the list scrolls above it; the status line never
 * shrinks and is always whole. In a window under 640px tall the orb is not
 * drawn at all (`[@media(max-height:640px)]`), so the heading and the line are all the card takes
 * and the list keeps its room. The off-and-empty banner, taller, scrolls
 * inside its own share instead.
 *
 * The orb's sparks follow the extraction and, beside it, the sessions
 * working now (`working`, from the sidebar's own model; nothing more is
 * fetched): a few slow sparks per working session, the slow turn when none.
 *
 * The whole card is one way into `#/brain` (owner, 2026-10-15: "the whole
 * block as an interactive element"): a click anywhere, or Enter or Space,
 * opens the screen; it takes focus and lights up on hover. The chevron and
 * *How it works* keep their own jobs and stop the click there.
 *
 * Before anything is built and while it is off, it is the banner instead:
 * the agents feeding the brain (BrainHero), *Free*, *One memory for all your
 * agents*, *Start building* and *How it works*. *Start building* runs nothing
 * here: it opens the screen, where the one-click start sits with its one
 * line and Details (rule 4) — the consent in this narrow column was
 * unreadable (owner, 2026-10-15).
 */
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { BrainAutoStatus } from '@/lib/api'
import { brainActivity, brainMode, buildFigures, isBuilding, isEntity, useBrainGraph, useBrainLanded, useBrainStatus } from '@/lib/brain'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { agentsLine, BRAIN_HEADLINE, BrainHero, FreePill, useAgentsUsed } from './BrainAgents'
import { BrainOrb } from './BrainOrb'
import { ChevronIcon } from './AppIcons'
import { BrainGlyph } from './BrainDrop'
import { SecondBrainModal } from './SecondBrainModal'
import './BrainLive.css'

const FOLD_KEY = 'caprock.app.brain-fold'
const NEWEST = 30

function readFold(): 'open' | 'closed' | null {
  try {
    const v = localStorage.getItem(FOLD_KEY)
    return v === 'open' || v === 'closed' ? v : null
  } catch {
    return null
  }
}

/** A click on something inside the card that has a job of its own: do it, and go no further. */
function own(fn: () => void) {
  return (e: MouseEvent) => { e.stopPropagation(); fn() }
}

export function BrainSidebar({ onOpen, working = 0 }: { onOpen: (hash: string) => void; working?: number }) {
  const { status } = useBrainStatus()
  const [fold, setFold] = useState(readFold)
  const [how, setHow] = useState(false)
  const open = fold ? fold === 'open' : true
  const { graph } = useBrainGraph({ limit: NEWEST }, 600)
  const agents = useAgentsUsed()
  const landed = useBrainLanded()
  const now = useNow(60_000)
  const toggle = () => {
    const next = open ? 'closed' : 'open'
    setFold(next)
    try { localStorage.setItem(FOLD_KEY, next) } catch { /* private window */ }
  }
  if (!status) return null
  const auto = status.auto
  const memories = (graph?.nodes ?? []).filter((n) => !isEntity(n.kind)).sort((a, b) => b.created_at - a.created_at)
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const today = memories.filter((n) => n.created_at >= midnight).length
  const { mode, metric, active } = brainMode(status, today)
  const building = isBuilding(auto)
  const banner = status.memories === 0 && !auto?.on
  const go = () => onOpen('#/brain')
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      go()
    }
  }
  const chevron = (
    <button
      type="button"
      onClick={own(toggle)}
      aria-expanded={open}
      aria-label={open ? 'Fold Second Brain' : 'Unfold Second Brain'}
      className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
    >
      <span className={`flex transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden>
        <ChevronIcon size={10} />
      </span>
    </button>
  )
  const dot = <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${active ? 'brain-live-dot bg-accent' : auto?.on ? 'bg-accent/60' : 'bg-fg-faint'}`} aria-hidden />
  const howLink = (
    <button type="button" onClick={own(() => setHow(true))} className="px-1.5 text-[12px] text-fg-muted hover:text-fg hover:underline">
      How it works
    </button>
  )
  return (
    // Under the list and above the footer, never in the list's scroll. It
    // gives way before the list does, down to a floor that still holds the
    // heading, a 64px orb and the whole status line (or a scrolled banner);
    // folded it is one row and does not shrink at all.
    <section
      className={`flex shrink-[20] flex-col border-t border-[var(--app-hairline)] px-2 pb-1 pt-1 ${open ? (banner ? 'min-h-[140px]' : 'min-h-[136px] [@media(max-height:640px)]:min-h-[64px]') : ''}`}
      aria-label="Second Brain"
      data-brain-sidebar
      data-brain-fold={open ? 'open' : 'closed'}
    >
      <div
        role="link"
        tabIndex={0}
        aria-label={`Open Second Brain — ${mode}${metric ? `, ${metric}` : ''}`}
        onClick={go}
        onKeyDown={onKey}
        className="mx-0.5 flex min-h-0 cursor-pointer flex-col rounded-[10px] outline-none transition-colors hover:bg-[var(--app-row-hover)] focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none"
        data-brain-block
      >
        {open ? (
          <div className="flex h-[28px] shrink-0 items-center gap-1.5 px-1.5 pt-1.5">
            <h2 className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-muted">
              <BrainGlyph size={12} className="shrink-0" />
              <span className="truncate">Second Brain</span>
            </h2>
            {chevron}
          </div>
        ) : (
          // Folded: one row — what it is doing, then a figure or two.
          <div className="flex h-[30px] min-w-0 shrink-0 items-center gap-1.5 px-1.5" data-brain-row>
            <h2 className="sr-only">Second Brain</h2>
            <BrainGlyph size={12} className="shrink-0 text-fg-muted" />
            {dot}
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg" data-brain-mode>{mode}</span>
            {metric && <span className="num shrink-0 text-[11.5px] text-fg-muted" data-brain-metric>{metric}</span>}
            {chevron}
          </div>
        )}
        {open && (
          banner ? (
            <div className="app-scroll min-h-0 overflow-y-auto px-1 pb-1.5 pt-1" data-brain-banner-box>
              <Banner auto={auto} onStart={go} howLink={howLink} />
            </div>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-col gap-1 px-1 pb-2" data-brain-card>
              <BrainOrb
                kinds={memories.map((n) => n.kind)}
                count={status.memories}
                agents={agents}
                activity={brainActivity(auto)}
                landed={landed}
                working={working}
                className="h-[150px] min-h-[64px] shrink [@media(max-height:640px)]:hidden"
                ariaLabel={`Second Brain: ${mode}`}
              />
              <StatusLine auto={auto} mode={mode} metric={metric} active={active} building={building} count={status.memories} newest={memories[0]?.created_at} now={now} dot={dot} />
            </div>
          )
        )}
      </div>
      {how && <SecondBrainModal onOpen={go} onClose={() => setHow(false)} />}
    </section>
  )
}

/** The one quiet line under the orb: the mode, a figure, and a thin bar while it builds. */
function StatusLine({ auto, mode, metric, active, building, count, newest, now, dot }: {
  auto?: BrainAutoStatus; mode: string; metric: string; active: boolean; building: boolean; count: number; newest?: number; now: number; dot: ReactNode
}) {
  const f = building ? buildFigures(auto) : null
  const share = f?.share ?? 0
  // Working: the mode, then how far. Idle: the count and when it last
  // grew ("16 memories · updated 1m ago"). Otherwise the mode, then the count.
  const idle = mode === 'Idle' && count > 0
  const lead = active ? `${mode}…` : idle ? `${count} ${count === 1 ? 'memory' : 'memories'}` : mode
  const after = active
    ? (f && f.sessions > 0 ? `${Math.min(f.read + (auto?.reading ? 1 : 0), f.sessions)} of ${f.sessions}` : '')
    : idle ? (newest ? `updated ${fmtAgo(newest, now)}` : '') : metric
  return (
    <div className="grid min-w-0 shrink-0 gap-1 px-1.5" data-brain-status data-brain-sidebar-live={building ? '' : undefined}>
      <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-snug">
        {dot}
        <span className="min-w-0 shrink truncate text-fg" data-brain-mode title={auto?.reading?.title}>{lead}</span>
        {after && <span className="num min-w-0 shrink-[2] truncate text-[11.5px] text-fg-muted">· {after}</span>}
      </p>
      {building && (
        <div className="h-[3px] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-fg-muted)_18%,transparent)]"
          role="progressbar" aria-label="Sessions read" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
          <div className="brain-live-bar h-full rounded-full bg-accent transition-[width] duration-700 motion-reduce:transition-none" style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      )}
    </div>
  )
}

/**
 * Off and empty: the agents this user runs feeding one brain (BrainHero),
 * *Free*, the headline, a line naming those agents, *Start building* (it
 * opens the screen) and *How it works*.
 */
function Banner({ auto, onStart, howLink }: { auto?: BrainAutoStatus; onStart: () => void; howLink: ReactNode }) {
  const agents = useAgentsUsed()
  return (
    <div
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] justify-items-center gap-1.5 rounded-[10px] border border-[var(--app-hairline)] bg-[var(--app-row-hover)] px-1.5 pb-2.5 pt-2 text-center"
      data-brain-banner="off"
    >
      <BrainHero agents={agents} className="h-auto w-full max-w-[280px]" />
      <FreePill className="mt-0.5" />
      <p className="px-1 text-[13.5px] font-semibold leading-snug text-balance text-fg" data-brain-headline>{BRAIN_HEADLINE}</p>
      <p className="-mt-1 px-1.5 text-[12px] leading-snug text-balance text-fg-muted" data-brain-agents-line>{agentsLine(agents)}</p>
      <div className="flex min-w-0 flex-wrap items-center justify-center gap-x-1 gap-y-1 px-1.5">
        {auto && (
          <button
            type="button"
            onClick={own(onStart)}
            className="mr-1 rounded-[6px] bg-accent px-2.5 py-1 text-[12.5px] font-medium text-panel hover:bg-accent-strong"
          >
            Start building
          </button>
        )}
        {howLink}
      </div>
    </div>
  )
}
