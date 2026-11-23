/**
 * The sidebar's 2nd Brain card (ADR-063), below the projects: the owner's
 * "collapsible block on the left where my second brain is constantly being
 * built" (translated). Named *2nd Brain* everywhere a user reads it (owner,
 * 2026-11-23); identifiers and routes keep `brain`.
 *
 * Unfolded, it is a small copy of the `#/brain` screen's graph
 * (BrainGraphCanvas `mini`, coloured by project as there), so opening the
 * screen shows the same picture, larger (owner, 2026-11-23: the turning orb
 * and the screen's graph were two pictures of one thing). It draws what the
 * card already fetches — the newest NEWEST memories, pinned first, and the
 * topics and projects they link to — and nothing more: no endpoint of its
 * own, no polling; it re-reads on the brain's live frames as before, and a
 * read that changed nothing drawn keeps the picture as it is. A memory that
 * lands flashes at its place in the accent (with *Show memories moving* on,
 * never under reduced motion). The canvas settles off screen, fades in and
 * then draws nothing until something changes: zero frames at rest, none
 * while the window is hidden. Under it, one quiet line of what it is doing,
 * from the daemon: "Reading acme-api… · 12 of 48", "3 sessions to read",
 * "Up to date · last built 14:02", "Paused", with a thin bar while it
 * builds. Before anything is kept it is the living brain (BrainOrb, `calm`)
 * instead, as the screen's card is.
 *
 * Folded, it is one row: the glyph (a small brain of dots and links,
 * BrainGlyph) and that same mode in words, with the count — what it does
 * now first (owner, 2026-10-15: "what it is doing right now matters more
 * than the numbers"). The chevron folds and unfolds it, remembered in this
 * browser; unfolding it folds a private module's row below it, and the
 * other way round (lib/sidebarAccordion).
 *
 * It sits under the list, above the sidebar's footer, never inside the
 * list's scroll (owner, 2026-10-15: with a long list of sessions the status
 * line under the picture was cut off by the footer). When the list and the
 * card do not both fit, the card gives way first — it shrinks twenty times
 * as readily as the list (`shrink-[20]`), and inside it only the picture
 * does, from 120px down to 64px — and the list scrolls above it; the status
 * line never shrinks and is always whole. In a window under 640px tall the
 * picture is not drawn at all (`[@media(max-height:640px)]`), so the heading
 * and the line are all the card takes and the list keeps its room. The
 * off-and-empty banner, taller, scrolls inside its own share instead.
 *
 * Folded by default (owner, 2026-10-15, translated: "compact but
 * interactive, not grabbing attention"): one quiet row in muted colours — a
 * small static glyph and the mode in words, *2nd Brain · Up to date ·
 * 140*, the figure bare so the row fits whole, or while it builds *Building · 12 of 48* (the session
 * being read of all in reach) over a 2px bar. The glyph is the only thing that
 * moves, a slow pulse, and only while a read actually runs. The row lights up a
 * little on hover, in place; a click opens the screen; the chevron unfolds
 * the picture upward, so it points up while folded and down while open.
 * A fold the viewer saved is kept: only the default changed.
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
 *
 * Memories moving (BrainArrivals; Settings → 2nd Brain, *Show memories
 * moving*): a read's memories leave its session as one silver wisp and
 * settle on the card's glyph with a ripple and *+N*; memories handed to a
 * new session leave the glyph for its tab.
 *
 * The faces on the folded row are the agents whose sessions were read in
 * the last 24 hours (readFaces); the one being read now glows softly, and
 * each says so in plain words on hover.
 */
import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { BrainAutoStatus } from '@/lib/api'
import { brainActivity, brainMode, brainState, buildFigures, clockOrDay, isBuilding, isEntity, useBrainGraph, useBrainLanded, useBrainStatus } from '@/lib/brain'
import { fmtAgo } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { agentsLine, BRAIN_HEADLINE, BrainHero, faceWords, FreePill, readFaces, useAgentsUsed, type ReadFace } from './BrainAgents'
import { Body, characterFor } from './Characters'
import { useSessionFace } from '@/lib/faces'
import { indexGraph } from '@/lib/brainview'
import { BrainOrb } from './BrainOrb'
import { BrainGraphCanvas } from './BrainGraphCanvas'
import { ChevronIcon } from './AppIcons'
import { BrainGlyph } from './BrainDrop'
import { SecondBrainModal } from './SecondBrainModal'
import { BrainArrivals } from './BrainArrivals'
import { setBrainFold, useBrainFold } from '@/lib/sidebarAccordion'
import './BrainLive.css'

/** The memories the card fetches and draws: the newest (pinned first), with what they link to. */
const NEWEST = 30
/** The picture's box: 120px, giving way down to 64px, and not drawn in a window under 640px tall. */
const PICTURE = 'h-[120px] min-h-[64px] shrink [@media(max-height:640px)]:hidden'

/** A click on something inside the card that has a job of its own: do it, and go no further. */
function own(fn: () => void) {
  return (e: MouseEvent) => { e.stopPropagation(); fn() }
}

export function BrainSidebar({ onOpen, working = 0 }: { onOpen: (hash: string) => void; working?: number }) {
  const { status } = useBrainStatus()
  // Kept in this browser, and an accordion with a module's row below
  // (lib/sidebarAccordion): unfolding this folds that.
  const fold = useBrainFold()
  const [how, setHow] = useState(false)
  // Where a thought arriving lands (BrainArrivals).
  const block = useRef<HTMLDivElement>(null)
  // Folded unless this viewer unfolded it (owner, 2026-10-15).
  const open = fold ? fold === 'open' : false
  const { graph } = useBrainGraph({ limit: NEWEST }, 600)
  const landed = useBrainLanded()
  const now = useNow(60_000)
  // A read that changed nothing drawn (most brain frames are progress) keeps
  // the same graph object, so the picture is not laid out again.
  const sig = graph ? `${graph.nodes.map((n) => n.id).join(',')}|${graph.edges.length}` : ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const picture = useMemo(() => graph, [sig])
  const tint = useMemo(() => (picture ? indexGraph(picture).colorOf : undefined), [picture])
  const toggle = () => setBrainFold(!open)
  if (!status) return null
  const auto = status.auto
  const faces = readFaces(auto)
  const memories = (graph?.nodes ?? []).filter((n) => !isEntity(n.kind)).sort((a, b) => b.created_at - a.created_at)
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const today = memories.filter((n) => n.kind !== 'note' && n.created_at >= midnight).length
  const { mode, metric, active } = brainMode(status, today)
  const building = isBuilding(auto)
  // Actually reading right now, not just with sessions queued: the glyph's pulse.
  const reading = active && !!(auto?.reading || auto?.running)
  // The folded row's words: while it builds, *Building · 12 of 48* (the
  // session being read of all in reach) over a thin bar; else the name, the
  // mode and the count — the memories as a bare figure, so the row fits a
  // narrow sidebar whole (owner-approved mockup, 2026-11-23); the words are
  // in its tooltip.
  const notes = status.notes ? `${status.notes} ${status.notes === 1 ? 'note' : 'notes'}` : ''
  const count = [status.memories > 0 ? String(status.memories) : '', notes].filter(Boolean).join(' · ')
  const countWords = [status.memories > 0 ? `${status.memories} ${status.memories === 1 ? 'memory' : 'memories'}` : '', notes].filter(Boolean).join(' · ')
  const state = brainState(auto, now)
  const rowText = active
    ? (state.m > 0 ? `Building · ${state.n} of ${state.m}` : `${mode}…`)
    : ['2nd Brain', mode, count].filter(Boolean).join(' · ')
  const rowTitle = active ? `${state.word} · ${state.detail}${auto?.reading?.title ? ` — ${auto.reading.title}` : ''}` : ['2nd Brain', mode, countWords].filter(Boolean).join(' · ')
  const banner = status.memories === 0 && !status.notes && !auto?.on
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
      aria-label={open ? 'Fold 2nd Brain' : 'Unfold 2nd Brain'}
      className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
    >
      <span className={`flex transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : '-rotate-90'}`} aria-hidden>
        <ChevronIcon size={10} />
      </span>
    </button>
  )
  // A still dot: in the sidebar only the folded row's glyph moves.
  const dot = <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${active ? 'bg-accent/70' : auto?.on ? 'bg-accent/45' : 'bg-fg-faint'}`} aria-hidden />
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
      aria-label="2nd Brain"
      data-brain-sidebar
      data-brain-fold={open ? 'open' : 'closed'}
    >
      <div
        ref={block}
        role="link"
        tabIndex={0}
        aria-label={`Open 2nd Brain — ${mode}${metric ? `, ${metric}` : ''}`}
        onClick={go}
        onKeyDown={onKey}
        className="mx-0.5 flex min-h-0 cursor-pointer flex-col rounded-[10px] outline-none transition-colors duration-150 hover:bg-[var(--app-row-hover)] focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none"
        data-brain-block
      >
        {open ? (
          <div className="flex h-[28px] shrink-0 items-center gap-1.5 px-1.5 pt-1.5">
            <h2 className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-fg-muted">
              <span className="flex shrink-0" data-brain-glyph="still"><BrainGlyph size={14} /></span>
              <span className="truncate">2nd Brain</span>
            </h2>
            {chevron}
          </div>
        ) : (
          // Folded: one quiet row — the glyph (pulsing slowly only while a
          // read runs) and the mode in words, muted.
          <div className="relative flex h-[30px] min-w-0 shrink-0 items-center gap-1.5 px-1.5" data-brain-row>
            <h2 className="sr-only">2nd Brain</h2>
            <span className={`flex shrink-0 text-fg-faint ${reading ? 'brain-glyph-reading' : ''}`} data-brain-glyph={reading ? 'reading' : 'still'}><BrainGlyph size={14} /></span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted" data-brain-mode title={rowTitle}>{rowText}</span>
            {faces.length > 0 && <ReadFaces faces={faces} />}
            {chevron}
            {building && state.share !== null && (
              // A hairline of progress under the row: sessions read of all in reach.
              <span className="absolute inset-x-1.5 bottom-[2px] h-[2px] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-fg-muted)_16%,transparent)]"
                role="progressbar" aria-label="Sessions read" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.share * 100)} data-brain-row-bar>
                <span className="block h-full rounded-full bg-accent/70 transition-[width] duration-700 motion-reduce:transition-none" style={{ width: `${Math.round(state.share * 100)}%` }} />
              </span>
            )}
          </div>
        )}
        {open && (
          banner ? (
            <div className="app-scroll min-h-0 overflow-y-auto px-1 pb-1.5 pt-1" data-brain-banner-box>
              <Banner auto={auto} onStart={go} howLink={howLink} />
            </div>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-col gap-1 px-1 pb-2" data-brain-card>
              {picture && memories.length > 0 ? (
                // The screen's graph, small: the newest NEWEST memories and
                // what they link to, coloured by project as on #/brain.
                <BrainGraphCanvas
                  graph={picture}
                  mini
                  tint={tint}
                  className={`w-full ${PICTURE}`}
                  ariaLabel={`2nd Brain graph: the newest ${memories.length} ${memories.length === 1 ? 'memory' : 'memories'} — ${mode}`}
                />
              ) : !graph && status.memories > 0 ? (
                // The graph is on its way: its room, held, so nothing jumps.
                <div className={PICTURE} aria-hidden data-brain-picture-wait />
              ) : (
                // Nothing kept yet: the living brain, as on the screen's card.
                <BrainOrb
                  kinds={memories.map((n) => n.kind)}
                  count={status.memories}
                  agents={faces.map((f) => f.agent)}
                  lit={faces.find((f) => f.now)?.agent}
                  activity={brainActivity(auto)}
                  landed={landed}
                  working={working}
                  calm
                  className={PICTURE}
                  ariaLabel={`2nd Brain: ${mode}`}
                />
              )}
              <StatusLine auto={auto} mode={mode} metric={metric} active={active} building={building} count={status.memories} newest={memories[0]?.created_at} now={now} dot={dot} />
            </div>
          )
        )}
      </div>
      {how && <SecondBrainModal onOpen={go} onClose={() => setHow(false)} />}
      <BrainArrivals card={block} />
    </section>
  )
}

/**
 * The agents read in the last 24 hours, as small faces, each with a quiet
 * count of its sessions read (owner, 2026-10-22: "show the actual current
 * numbers"); the one read now glows (BrainLive.css).
 */
function ReadFaces({ faces }: { faces: ReadFace[] }) {
  const claudeFace = useSessionFace(undefined)
  return (
    <span className="flex shrink-0 items-center gap-[5px]" data-brain-faces>
      {faces.map((f) => {
        const words = faceWords(f)
        return (
          <span key={f.agent} className="flex items-center gap-[2px]" title={words} aria-label={words} role="img" data-brain-face-item={f.agent}>
            <span className="brain-face" data-brain-face={f.agent} data-lit={f.now ? '' : undefined}>
              <svg viewBox="0 0 80 80" aria-hidden className="h-[13px] w-[13px]">
                <g transform="translate(9 6) scale(0.78)">
                  <Body who={characterFor(f.agent)} face={f.agent === 'claude' ? claudeFace : undefined} />
                </g>
              </svg>
            </span>
            {f.sessions > 0 && <span className="num text-[10.5px] leading-none text-fg-faint" aria-hidden data-brain-face-count>{f.sessions}</span>}
          </span>
        )
      })}
    </span>
  )
}

/** The one quiet line under the orb: the mode, a figure, and a thin bar while it builds. */
function StatusLine({ auto, mode, metric, active, building, count, newest, now, dot }: {
  auto?: BrainAutoStatus; mode: string; metric: string; active: boolean; building: boolean; count: number; newest?: number; now: number; dot: ReactNode
}) {
  const f = building ? buildFigures(auto) : null
  const share = f?.share ?? 0
  // Working: the mode, then how far. Up to date: when it last built (the
  // newest read that kept something), else when a memory last landed
  // ("Up to date · last built 14:02"). Otherwise the mode, then the count.
  const idle = mode === 'Up to date' && count > 0
  const lead = active ? `${mode}…` : mode
  const after = active
    ? (f && f.sessions > 0 ? `${Math.min(f.read + (auto?.reading ? 1 : 0), f.sessions)} of ${f.sessions}` : '')
    : idle ? (auto?.last_read ? `last built ${clockOrDay(auto.last_read, now)}` : newest ? `updated ${fmtAgo(newest, now)}` : metric) : metric
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
