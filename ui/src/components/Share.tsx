/**
 * Share these numbers — from anywhere, in one click.
 *
 * One card (owner, 2026-10-25): the Week card (WeekCard.tsx), the same
 * figures in landscape and portrait, from GET /v1/week — GitHub's pull
 * requests where the daemon holds them, hand-run sessions only. It replaced
 * two styles (a canvas "Figures" card led by the plan's multiple and the
 * "Story" card led by PRs), which made the format change the message.
 *
 * What a browser can do with the picture is limited, and the limit shapes
 * the buttons (ShareActions.tsx): the Web Share API hands the file to the
 * operating system's share sheet where it exists; everywhere else a social
 * site cannot be handed an image by URL, so the card goes on the clipboard
 * and the site opens with the words written.
 *
 * The card itself carries `caprock.dev`, so the link travels with the image
 * even when someone posts it without the text.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useApi } from '@/lib/useApi'
import { api, type Week } from '@/lib/api'
import { cardFilename, PERIOD_LABEL, screenLook, type CardLook, type SharePeriod } from './ShareCard'
import { CARD_SIZE, WeekCard, type CardLayout } from './WeekCard'
import { Scaled } from './Scaled'
import { renderCardPNG } from '@/lib/cardimage'
import { ShareActions, xPostURL } from './ShareActions'
import { CloseButton, DialogBackdrop } from './Dialog'
import { periodWords, planOf, postText, type CardPlan } from '@/lib/week'
import { currentStory, fetchStory, FRESH_MS, lastStory, warmShare } from '@/lib/sharecache'

/** What the desktop app's File → Share Your Figures… dispatches on the page. */
export const SHARE_EVENT = 'caprock:share'

/** The share icon: three dots joined. */
export function ShareGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </svg>
  )
}

export function ShareButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* Visible, not loud (owner, 2026-10-10): a tinted pill with the share
        * icon is found without reading the row and does not outshout the
        * figures it shares. */}
      <button
        onClick={() => setOpen(true)}
        // The default card's figures start loading on the way to the click.
        onMouseEnter={warmShare}
        onFocus={warmShare}
        className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/15 px-2.5 py-[3px] text-[12px] font-medium text-accent transition-colors hover:bg-accent/25"
        title="Draw a shareable picture of your figures"
      >
        <ShareGlyph />
        Share
      </button>
      {open && <ShareDialog onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * The quiet way in from every tab: a small icon on the sidebar's Today card
 * (owner, 2026-10-25: he works in session tabs and could not find how to
 * share at all). The dialog is portalled, since a fixed sheet inside the
 * sidebar is clipped to it.
 */
export function ShareWeekIcon({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        data-share-week
        onClick={() => setOpen(true)}
        onMouseEnter={warmShare}
        onFocus={warmShare}
        aria-label="Share your week"
        title="Share your week"
        className={`grid h-5 w-6 shrink-0 place-items-center rounded-[5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-accent ${className}`}
      >
        <ShareGlyph size={11} />
      </button>
      {open && createPortal(<ShareDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

const LAYOUT_KEY = 'caprock-share-layout'
const LOOK_KEY = 'caprock-share-look'

function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null
    return v && allowed.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}

function remember(key: string, v: string) {
  try { localStorage.setItem(key, v) } catch { /* a remembered choice is a convenience */ }
}

/** Two frames, so a card just given new figures has been laid out before it is captured. */
const settled = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

/** The period as the progress line says it. */
const PERIOD_WORDS: Record<SharePeriod, string> = {
  today: 'today',
  '7d': 'this week',
  '30d': 'this month',
  all: 'all time',
}

// How many share sheets are open, so the share toast steps aside while one
// is (it sat over the sheet's backdrop in the app, 2026-10-25).
let sheetsOpen = 0
const sheetSubs = new Set<() => void>()
function sheetChanged(d: number) { sheetsOpen += d; for (const f of sheetSubs) f() }
/** Whether a share sheet is open anywhere on the page. */
export function useShareSheetOpen(): boolean {
  return useSyncExternalStore((f) => { sheetSubs.add(f); return () => { sheetSubs.delete(f) } }, () => sheetsOpen > 0, () => false)
}

export function ShareDialog({ onClose, initialPeriod = '7d' }: { onClose: () => void; initialPeriod?: SharePeriod }) {
  useEffect(() => { sheetChanged(1); return () => sheetChanged(-1) }, [])
  // Which stretch the card is about. Defaults to the week: a working week is
  // the thing people actually finish and want to show.
  const [period, setPeriod] = useState<SharePeriod>(initialPeriod)
  const [layout, setLayoutState] = useState<CardLayout>(() => remembered(LAYOUT_KEY, ['land', 'port'] as const, 'land'))
  // The ground the card is drawn on: the screen's by default, remembered once
  // chosen. A dark card stands out in a light feed and the paper one matches
  // caprock.dev, so it is the poster's choice, not the dashboard's theme.
  const [look, setLookState] = useState<CardLook>(() => remembered(LOOK_KEY, ['dark', 'paper'] as const, screenLook()))
  const setLook = (l: CardLook) => { setLookState(l); remember(LOOK_KEY, l) }
  const setLayout = (l: CardLayout) => { setLayoutState(l); remember(LAYOUT_KEY, l) }
  // The plan the user stated, for the multiple; the card without it says dollars.
  const [plan, setPlan] = useState<CardPlan | undefined>(undefined)
  useEffect(() => {
    let live = true
    api.settings().then((s) => { if (live) setPlan(planOf(s)) }).catch(() => { /* dollars, then */ })
    return () => { live = false }
  }, [])

  const [story, setStory] = useState<Week | undefined>(undefined)
  // What is on screen is the last reading, and the current one is on its way.
  const [stale, setStale] = useState<number>(0)
  const [failed, setFailed] = useState(false)
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const card = useRef<HTMLElement>(null)
  // The post's words: written from the figures until the person edits them,
  // and written afresh when the period changes.
  const [edited, setEdited] = useState<string | undefined>(undefined)
  useEffect(() => { setEdited(undefined) }, [period])

  // The last figures for the period at once, the current ones behind them.
  useEffect(() => {
    let live = true
    const kept = lastStory(period)
    setStory(kept?.value)
    setFailed(false)
    setStartedAt(Date.now())
    if (kept && Date.now() - kept.at < FRESH_MS) { setStale(0); return () => { live = false } }
    setStale(kept ? kept.at : 0)
    fetchStory(period)
      .then((w) => { if (live) { setStory(w); setStale(0) } })
      .catch(() => { if (live) { setStale(0); if (!kept) setFailed(true) } })
    return () => { live = false }
  }, [period])

  const size = CARD_SIZE[layout]
  const fileName = () => cardFilename().replace('caprock-', `caprock-${period}-${size.w}x${size.h}-`)

  /**
   * The image that leaves the machine, always from the current figures. When
   * the screen shows an earlier reading, this waits for the current one first.
   */
  const build = async (): Promise<Blob | null> => {
    const w = await currentStory(period)
    setStory(w)
    setStale(0)
    await settled()
    if (!card.current) return null
    return renderCardPNG(card.current, size)
  }

  const words = periodWords(period)
  const empty = !!story && story.sessions === 0
  const text = edited ?? ((story && postText(story, words.when, words.noun)) || xText(period))
  const seg = (on: boolean) => `rounded-[5px] px-2 py-1 text-[12px] transition-colors ${on ? 'bg-panel text-fg font-medium shadow-sm' : 'text-fg-muted hover:text-fg'}`
  const group = 'inline-flex items-center gap-0.5 rounded-md border border-border bg-panel-2 p-0.5'

  return (
    <DialogBackdrop
      onClose={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 px-4 py-[5vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Share your figures"
    >
      <div className="w-[760px] max-w-full rounded-[var(--radius-panel)] border border-border-strong bg-panel shadow-[var(--shadow-panel)]" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center border-b border-border py-1.5 pl-4 pr-2">
          <h2 className="text-[13px] font-medium text-fg">Share your figures</h2>
          <CloseButton onClick={onClose} className="ml-auto" />
        </header>

        <div className="px-4 py-4 sm:px-5">
          {/* What the card is about, then how it looks: one row of small
            * segmented controls above the picture, so the picture can be big. */}
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className={group} role="group" aria-label="Period">
              {(['today', '7d', '30d', 'all'] as SharePeriod[]).map((p) => (
                <button key={p} onClick={() => setPeriod(p)} aria-pressed={period === p} className={seg(period === p)}>
                  {PERIOD_LABEL[p]}
                </button>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <div className={group} role="group" aria-label="Card look">
                {(['dark', 'paper'] as CardLook[]).map((l) => (
                  <button key={l} onClick={() => setLook(l)} aria-pressed={look === l} className={seg(look === l)}>
                    {l === 'dark' ? 'Dark' : 'Paper'}
                  </button>
                ))}
              </div>
              <div className={group} role="group" aria-label="Card size">
                {(['land', 'port'] as CardLayout[]).map((l) => (
                  <button key={l} onClick={() => setLayout(l)} aria-pressed={layout === l} className={seg(layout === l)}
                    title={`${CARD_SIZE[l].w}×${CARD_SIZE[l].h} PNG`}>
                    {l === 'land' ? 'Landscape' : 'Portrait'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* The card, as big as the sheet allows: it is the thing being
            * decided — the buttons only choose where it goes. */}
          <div className="relative mb-4">
            {story && !empty ? (
              <Scaled w={size.w} h={size.h} max={layout === 'port' ? 380 : 718}>
                <WeekCard ref={card} week={story} layout={layout} when={words.when} noun={words.noun} look={look} plan={plan} />
              </Scaled>
            ) : (
              <div className="mx-auto overflow-hidden rounded-[10px] border border-border bg-panel-2"
                style={{ aspectRatio: `${size.w} / ${size.h}`, maxWidth: layout === 'port' ? 380 : undefined }}>
                {empty ? (
                  <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-fg-muted">
                    Nothing ran {words.when.replace('— ', '')} on this machine, so there is no card yet.
                  </div>
                ) : failed ? (
                  <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-fg-faint">
                    Could not read the figures. Close and open the sheet to try again.
                  </div>
                ) : (
                  <Progress label={`Counting ${PERIOD_WORDS[period]}: PRs, sessions, agents`} startedAt={startedAt} />
                )}
              </div>
            )}
            {stale > 0 && story && (
              <div className="absolute right-2 top-2 rounded-sm bg-panel/90 px-1.5 py-0.5 text-[10.5px] text-fg-muted shadow-sm" role="status">
                from {new Date(stale).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · updating…
              </div>
            )}
          </div>

          <ShareActions build={build} fileName={fileName} text={text} onText={setEdited}
            disabled={!story || empty} onShared={onClose} />

          <p className="mt-3 border-t border-border pt-2.5 text-[12px] text-fg-muted">
            Totals only, no names or paths. Drawn on your machine, uploaded nowhere.
          </p>
        </div>
      </div>
    </DialogBackdrop>
  )
}

/**
 * The X post before the figures are read. With them, the words carry the
 * counts (postText in lib/week.ts). No link: the card says caprock.dev, and
 * a link made X and Threads show the site's own dark preview in place of the
 * card the user chose (owner, 2026-10-25).
 */
export function xIntent(period: SharePeriod): string {
  return xPostURL(xText(period))
}

/** The post's words while the figures are not there yet. */
export function xText(period: SharePeriod): string {
  const what = period === 'all' ? 'My coding agents, all time' : `My coding agents ${PERIOD_LABEL[period]}`
  return `${what}, measured on my own machine with Caprock — free and open source.`
}

/**
 * What the wait looks like: the card's outline and how long it has been. An
 * empty box saying "drawing…" read as stuck after two seconds; the same wait
 * with the seconds ticking reads as work.
 */
function Progress({ label, startedAt }: { label: string; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(t)
  }, [])
  const secs = Math.max(0, (now - startedAt) / 1000)
  return (
    <div className="relative h-full" role="status" aria-live="polite" aria-label="Drawing your card">
      <div className="absolute inset-0 grid content-start gap-2.5 p-4 opacity-50 motion-safe:animate-pulse" aria-hidden>
        <div className="h-2.5 w-24 rounded-sm bg-border" />
        <div className="h-6 w-3/4 rounded-sm bg-border" />
        <div className="h-6 w-1/2 rounded-sm bg-border" />
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-panel-2/60 px-4">
        <div className="text-[13px] font-medium text-fg">Drawing your card…</div>
        <div className="text-[12px] text-fg-faint">{label}</div>
        <div className="num text-[11px] text-fg-faint">{secs.toFixed(1)} s</div>
      </div>
    </div>
  )
}

export function ShareCard() {
  // Only whether there is anything to share: no live tick, and the question
  // the panel around it asks, so it shares that request (lib/refresh.ts).
  const h = useApi(() => api.history('all'), [], { intervalMs: 60000, live: false, share: 'history:all' })
  const [open, setOpen] = useState(false)
  const t = h.data?.totals
  if (!t || t.sessions === 0) return null

  return (
    <>
      {/* Opens the dialog rather than downloading on the spot: the dialog is
        * where the card is seen before it leaves, and where the work is
        * announced while it happens. */}
      <button
        onClick={() => setOpen(true)}
        onMouseEnter={warmShare}
        onFocus={warmShare}
        className="rounded-md border border-accent/45 bg-accent/[0.08] px-2.5 py-1 text-[12px] text-accent hover:bg-accent/[0.16]"
        title="Draw a shareable image of these figures"
      >
        Share these numbers
      </button>
      {open && <ShareDialog onClose={() => setOpen(false)} />}
    </>
  )
}
