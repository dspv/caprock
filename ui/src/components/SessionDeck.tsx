/**
 * The session deck (.ai/21-app.md § What the user sees, Session deck): a band
 * under the terminal of the agent in front. Opening it pushes the terminal's
 * bottom up, so Claude Code's prompt sits nearer the middle of the screen
 * than its edge (owner, 2026-10-11, translated: "I basically type in the
 * centre, a bit below the middle of the screen — that's comfortable — and in
 * this new area show data useful to me while I work"), and the room it makes
 * carries the session's live figures in one dense row: what it is doing now,
 * what it has cost and what the next call costs, how full its context is,
 * the branch with what is not committed or pushed, and the session's latest
 * pull requests with their CI. No chart: the dashboard has those (owner,
 * 2026-10-11: "we already have charts everywhere").
 *
 * Every figure but the pull requests' is one the workspace already holds: the
 * session row the sidebar polls and the session's own calls and turns — fetched
 * once and followed on the live socket, shared with the cockpit
 * (lib/sessionEvents.ts). Nothing is estimated, and a figure the agent does
 * not report is left out rather than drawn as zero.
 *
 * Cheap on purpose. It is a sibling of the terminals, so nothing here redraws
 * one. Closed, it is not mounted: no clock, no subscription. While its
 * divider is dragged the band grows over the terminal and the terminal's own
 * box changes once, on release — one fit and one PTY resize, not one per
 * frame. Arrow keys on the divider settle the same way.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { api, type SessionPRLive, type SessionSummary, type Summary } from '@/lib/api'
import { fmtPct, fmtTokens, fmtUSD } from '@/lib/format'
import { DECK_DEFAULT, DECK_MAX_SHARE, DECK_TALL, clampDeck, deckKeyStep } from '@/lib/deck'
import { githubApi, prTone, type PRTone } from '@/lib/github'
import { openExternal } from '@/lib/nudges'
import { keys } from '@/lib/appkeys'

/** How long arrow keys on the divider rest before the terminal is fitted to the new height. */
export const KEY_SETTLE_MS = 250

export interface SessionDeckProps {
  s: SessionSummary
  sessionId: string
  hasPermission: boolean
  /** The day's summary: the plan windows. */
  summary?: Summary
  /** Files changed in the session's checkout, as the sidebar counts them; absent when not known. */
  changed?: number
  /** The checkout's branch and commits not pushed, as the sidebar knows them. */
  branch?: string
  ahead?: number
  onReviewChanges?: () => void
  /** The height kept, in CSS pixels. */
  height: number
  /** A new height, once a drag or the arrow keys settle. */
  onResize: (height: number) => void
  onClose: () => void
}

export function SessionDeck(props: SessionDeckProps) {
  const { height, onResize } = props
  const box = useRef<HTMLDivElement>(null)
  // The height while the divider moves: the band is drawn at it, over the
  // terminal, and the terminal's own box waits for the release.
  const [draft, setDraft] = useState<number | null>(null)
  const settle = useRef(0)
  useEffect(() => () => window.clearTimeout(settle.current), [])

  const pane = () => box.current?.parentElement?.clientHeight || undefined
  const current = () => draft ?? (box.current?.getBoundingClientRect().height || height)

  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const y0 = e.clientY
    const h0 = current()
    const p = pane()
    let last: number | null = null
    const onMove = (m: PointerEvent) => {
      last = clampDeck(h0 + (y0 - m.clientY), p)
      setDraft(last)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.documentElement.removeAttribute('data-deck-drag')
      if (last !== null && last !== Math.round(h0)) onResize(last)
      setDraft(null)
    }
    document.documentElement.setAttribute('data-deck-drag', '')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const nudge = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && draft !== null) {
      e.preventDefault()
      window.clearTimeout(settle.current)
      setDraft(null)
      return
    }
    const next = deckKeyStep(e.key, current(), pane())
    if (next === undefined) return
    e.preventDefault()
    setDraft(next)
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      onResize(next)
      setDraft(null)
    }, KEY_SETTLE_MS)
  }

  const shown = draft ?? height
  return (
    <div
      ref={box}
      data-deck
      className="relative shrink-0"
      // Never past its share of the pane, whatever was kept: a window made
      // smaller since must not leave the terminal a sliver.
      style={{ height: `min(${height}px, ${DECK_MAX_SHARE * 100}%)` }}
    >
      <section
        aria-label="Session deck"
        className="deck-band absolute inset-x-0 bottom-0 z-30 flex flex-col bg-[var(--app-chrome-bg)]"
        style={{ height: draft !== null ? `${draft}px` : '100%' }}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the session deck"
          aria-valuenow={Math.round(shown)}
          aria-valuemin={0}
          tabIndex={0}
          title={`Drag to resize · double-click for the default height · ${keys('⌘B')} hides it`}
          onPointerDown={drag}
          onKeyDown={nudge}
          onDoubleClick={() => onResize(clampDeck(DECK_DEFAULT, pane()))}
          className="deck-divider group absolute inset-x-0 -top-[4px] z-10 h-[8px] cursor-row-resize outline-none"
          data-dragging={draft !== null || undefined}
        >
          <span aria-hidden className="deck-grip absolute left-1/2 top-[2px] h-[4px] w-[36px] -translate-x-1/2 rounded-full" />
        </div>
        <DeckBody {...props} tall={shown >= DECK_TALL} />
      </section>
    </div>
  )
}

function DeckBody({ s, sessionId, changed, branch, ahead, onReviewChanges, onClose, tall }: SessionDeckProps & { tall: boolean }) {
  const ctx = s.context
  return (
    // A container, so the branch gives way first as the terminal narrows
    // (the sidebar and the inspector both open). No clock and no event
    // subscription: what it is doing and what it cost are the sidebar's and
    // the inspector's (owner, 2026-10-11: "Spent doesn't help", "Working
    // now is debatable").
    <div className="@container flex min-h-0 flex-1 items-stretch overflow-hidden">
      {ctx && <Context ctx={ctx} tall={tall} />}
      <Branch branch={branch || s.git_branch} changed={changed} ahead={ahead} onReview={onReviewChanges} />
      <PRs sessionId={sessionId} />
      <div className="flex shrink-0 items-start pr-2 pt-1.5">
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close the session deck (${keys('⌘B')})`}
          title="Hide the deck; the same key brings it back"
          className="flex h-[24px] items-center gap-1.5 rounded-[6px] px-1.5 text-[11.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg"
        >
          Hide <kbd aria-hidden className="app-kbd-key">{keys('⌘B')}</kbd>
        </button>
      </div>
    </div>
  )
}

/** The display classes of a cell that is drawn only from a container width up; literal, so Tailwind finds them. */
const SHOWN_FROM: Record<number, string> = {
  720: 'hidden @min-[720px]:flex',
  1000: 'hidden @min-[1000px]:flex',
}

function Cell({ label, right, className = '', grow = false, below, children }: { label: string; right?: ReactNode; className?: string; grow?: boolean; below?: 720 | 1000; children: ReactNode }) {
  return (
    <div className={`${below ? SHOWN_FROM[below] : 'flex'} min-w-0 flex-col gap-1 border-r border-[var(--app-hairline)] px-3 pb-2 pt-2 last-of-type:border-r-0 ${grow ? '' : 'overflow-hidden'} ${className}`}>
      <div className="flex items-baseline gap-2">
        <h4 className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">{label}</h4>
        {right && <div className="ml-auto min-w-0 truncate text-[11px] text-fg-faint">{right}</div>}
      </div>
      {children}
    </div>
  )
}

function Context({ ctx, tall }: { ctx: NonNullable<SessionSummary['context']>; tall: boolean }) {
  const pct = Math.max(0, Math.min(100, ctx.pct))
  const tone = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok'
  return (
    <Cell label="Context" className="w-[136px] shrink-0">
      <p className={`num text-[20px] font-semibold leading-none tracking-[-0.02em] ${tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg'}`}>{fmtPct(pct)}</p>
      <div className="cockpit-track relative h-[5px] overflow-hidden rounded-full" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="cockpit-fill h-full rounded-full" data-tone={tone} style={{ width: `${Math.max(pct, 1.5)}%` }} />
      </div>
      {ctx.next_call_usd > 0 && (
        <p className="num truncate text-[11px] text-fg-muted" title="What every call now pays to re-read the context">next call <span className="text-fg">{fmtUSD(ctx.next_call_usd)}</span></p>
      )}
      {tall && <p className="num truncate text-[11px] text-fg-faint">{fmtTokens(ctx.tokens)} / {fmtTokens(ctx.window)}</p>}
    </Cell>
  )
}


/** How often the PR cell asks again: sooner while a check is running. The
 *  daemon keeps each pull request for about as long, so a poll it can answer
 *  from what it holds costs GitHub nothing. */
const PRS_PENDING_MS = 20_000
const PRS_IDLE_MS = 60_000

const PR_DOT: Record<PRTone, string> = {
  ok: 'bg-ok', fail: 'bg-danger', pending: 'bg-warn', merged: 'bg-[#a371f7]', closed: 'bg-fg-faint', none: 'bg-fg-faint/70',
}

/** The branch the session works on, what is not committed and what is not pushed. */
function Branch({ branch, changed, ahead, onReview }: { branch?: string; changed?: number; ahead?: number; onReview?: () => void }) {
  if (!branch) return null
  const bits = [
    typeof changed === 'number' ? (changed ? `${changed} not committed` : 'clean') : '',
    ahead ? `${ahead} not pushed` : '',
  ].filter(Boolean)
  return (
    <Cell label="Branch" className="w-[176px] shrink-0" below={720}>
      <p className="mono truncate text-[13px] font-medium text-fg" title={branch}>{branch}</p>
      {bits.length > 0 && <p className={`truncate text-[11.5px] ${changed || ahead ? 'text-warn' : 'text-fg-muted'}`}>{bits.join(' · ')}</p>}
      {onReview && !!changed && (
        <button type="button" onClick={onReview} className="flex w-fit items-center gap-1.5 text-left text-[11.5px] text-accent underline-offset-2 hover:underline">Review changes <kbd aria-hidden className="app-kbd-key">{keys('⇧⌘G')}</kbd></button>
      )}
    </Cell>
  )
}

/** One PR's state in a few characters: CI first, then the review. */
interface PRStatus {
  /** The CI in a few characters, '' when there is none to show. */
  ci: string
  ciTone: PRTone
  /** Where the CI is looked at: the failing or running job, else the PR's checks. */
  ciUrl?: string
  /** merged, closed, draft, approved…; '' for a plain open PR. */
  state: string
  tone: PRTone
}

/** One PR's CI and state, in two columns that line up row to row. */
function prStatus(p: SessionPRLive): PRStatus {
  const pr = p.live
  if (!pr) {
    if (p.merged_at) return { ci: '', ciTone: 'none', state: 'merged', tone: 'merged' }
    if (p.closed_at) return { ci: '', ciTone: 'none', state: 'closed', tone: 'closed' }
    return { ci: '', ciTone: 'none', state: 'open', tone: 'none' }
  }
  const c = pr.checks
  const total = c.items.length
  let ci = ''
  let ciTone: PRTone = 'none'
  let ciUrl: string | undefined = total ? `${pr.url}/checks` : undefined
  if (c.state === 'fail') {
    const failed = c.items.filter((i) => i.state === 'fail')
    ci = `✗ ${failed[0]?.name ?? 'failed'}${failed.length > 1 ? ` +${failed.length - 1}` : ''}`
    ciTone = 'fail'
    ciUrl = failed.find((i) => i.url)?.url ?? ciUrl
  } else if (c.state === 'pending') {
    ci = `${total - c.pending}/${total} running`
    ciTone = 'pending'
    ciUrl = c.items.find((i) => i.state === 'pending' && i.url)?.url ?? ciUrl
  } else if (c.state === 'pass') {
    ci = `✓ ${total} passed`
    ciTone = 'ok'
  } else if (pr.state === 'open') ci = 'no CI'
  const review = pr.state === 'open' ? (pr.review === 'approved' ? 'approved' : pr.review === 'changes_requested' ? 'changes' : '') : ''
  const state = pr.state !== 'open' ? pr.state : pr.draft ? 'draft' : review
  const tone: PRTone = pr.state !== 'open' ? prTone(pr) : pr.review === 'changes_requested' ? 'fail' : pr.review === 'approved' ? 'ok' : 'none'
  return { ci, ciTone, ciUrl, state, tone }
}

const STATUS_TEXT: Record<PRTone, string> = {
  ok: 'text-ok', fail: 'text-danger', pending: 'text-warn', merged: 'text-[#a371f7]', closed: 'text-fg-faint', none: 'text-fg-muted',
}

/**
 * The session's latest pull requests and their CI (owner, 2026-10-11: "I'd
 * look at the statuses of the latest PRs, CI on them if possible"). Asked of
 * the daemon while the deck is open and the window is visible: every 20 s
 * while a check runs, else every minute.
 */
function PRs({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<{ connected: boolean; prs: SessionPRLive[] }>()
  const [connecting, setConnecting] = useState(false)
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    let timer = 0
    const tick = async () => {
      let next = PRS_IDLE_MS
      if (!document.hidden) {
        try {
          const d = await api.sessionPRs(sessionId)
          if (!alive) return
          setData(d)
          if (d.prs.some((p) => p.live?.checks.state === 'pending')) next = PRS_PENDING_MS
        } catch { /* the last answer stays */ }
      }
      if (alive) timer = window.setTimeout(() => void tick(), next)
    }
    void tick()
    const onVisible = () => { if (!document.hidden) { window.clearTimeout(timer); void tick() } }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [sessionId, n])

  // One click turns the integration on through the GitHub CLI's own login
  // (ADR-047: off until the user turns it on; this button is that). Without
  // a usable `gh`, Settings is where a token goes.
  const connect = async () => {
    setConnecting(true)
    try {
      const st = await githubApi.connect('gh')
      if (st.connected) setN((x) => x + 1)
      else location.hash = '#/settings'
    } catch {
      location.hash = '#/settings'
    } finally {
      setConnecting(false)
    }
  }
  const prs = data?.prs ?? []
  return (
    <Cell label="Pull requests" className="min-w-[220px] flex-[2.2_1_0]"
      right={data && !data.connected && prs.length > 0
        ? <button type="button" disabled={connecting} onClick={() => void connect()} title="Reads CI and reviews through your GitHub CLI login; turn it off in Settings → GitHub" className="text-accent hover:underline disabled:opacity-60">{connecting ? 'connecting…' : 'connect GitHub for CI'}</button>
        : undefined}>
      {data && prs.length === 0 && <p className="text-[12px] text-fg-faint">No PR from this session yet.</p>}
      <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
        {prs.map((p) => {
          const st = prStatus(p)
          return (
            <li key={p.url} data-deck-pr={p.number}
              className="grid min-w-0 grid-cols-[8px_auto_minmax(0,1fr)_112px_56px] items-center gap-x-2 rounded-[5px] text-[12.5px] hover:bg-[var(--app-row-hover)]">
              <span aria-hidden className={`h-2 w-2 rounded-full ${PR_DOT[st.ciTone === 'none' ? st.tone : st.ciTone]}`} />
              <button type="button" onClick={() => openExternal(p.live?.url || p.url)} title={`${p.live?.title || p.title || ''}\nOpen the pull request on GitHub`}
                className="col-span-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-left">
                <span className="num text-fg">#{p.number}</span>
                <span className="truncate text-fg-muted">{p.live?.title || p.title}</span>
              </button>
              {st.ci && st.ciUrl
                ? <button type="button" data-deck-ci onClick={() => openExternal(st.ciUrl!)} title="Open the CI run on GitHub"
                    className={`truncate text-left font-medium underline-offset-2 hover:underline ${STATUS_TEXT[st.ciTone]}`}>CI {st.ci}</button>
                : <span className={`truncate font-medium ${STATUS_TEXT[st.ciTone]}`}>{st.ci && `CI ${st.ci}`}</span>}
              <span className={`truncate font-medium ${STATUS_TEXT[st.tone]}`}>{st.state}</span>
            </li>
          )
        })}
      </ul>
    </Cell>
  )
}
