/**
 * A pull request's checks in one short group, as the deck's rows and the
 * cockpit's CI block draw them (owner, 2026-10-14, translated: "now the
 * indicators are completely incomprehensible"; he had liked the step
 * circles). A circle per state, never per check, each with its count and
 * the word that says it: "✗ 1 failed  ● 1 running  ✓ 10", the failed first,
 * the running one pulsing, skipped and cancelled folded into a dim
 * "2 skipped" only when there are any. A finished all-green PR is one token,
 * "✓ all 12 · 6m". Hover (or focus) lists every check: its name, OS, state —
 * the step a failed one failed at, once its run was read — and its time; a
 * click on one hands it to the caller, as the circles did.
 *
 * The deck offers the circles back beside it (view="circles", its default:
 * the owner, 2026-10-14, translated, of the circles: "I like everything
 * now"): a small circle per check in the order they started, coloured by its
 * state, the running ones pulsing, then the time; the same hover card names
 * every one. A click on a circle hands that check to the caller.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { CHECK_BAR_GAP, NO_RUNNER_TITLE, checkBar, checkBarWords, checksSentence, fmtRun, nodeBaseName, osName, shortRun, type CITone, type ChecksSummary, type ChecksView, type CheckBarWord, type DeltaTone, type PipeNode } from '@/lib/ci'
import { placeBeside, placeNear } from '@/lib/popoverPlace'

/** A state's circle: ✓ on green, ✗ on red, amber pulsing while running, hollow queued, a slash skipped; a muted-amber ⚠ for a job GitHub never gave a machine. */
export function StateMark({ tone }: { tone: CITone }) {
  if (tone === 'norunner') {
    return (
      <svg aria-hidden viewBox="0 0 10 10" data-mark={tone} className="h-[10px] w-[10px] shrink-0 text-norunner">
        <path d="M5 0.6 9.6 9.2H0.4Z" fill="currentColor" />
        <path d="M5 3.6V6M5 7.4V7.5" fill="none" stroke="var(--app-chrome-bg, #fff)" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    )
  }
  if (tone === 'pass' || tone === 'fail') {
    return (
      <svg aria-hidden viewBox="0 0 10 10" data-mark={tone} className={`h-[10px] w-[10px] shrink-0 ${tone === 'pass' ? 'text-ok' : 'text-danger'}`}>
        <circle cx="5" cy="5" r="5" fill="currentColor" />
        <path d={tone === 'pass' ? 'M2.8 5.2 4.3 6.6 7.2 3.6' : 'M3.3 3.3 6.7 6.7M6.7 3.3 3.3 6.7'} fill="none" stroke="var(--app-chrome-bg, #fff)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return <span aria-hidden data-mark={tone} className="pipe-node" data-tone={tone} />
}

const WORD: Record<CITone, string> = { pass: 'passed', fail: 'failed', norunner: 'no runner', running: 'running', queued: 'queued', skipped: 'skipped' }
const TEXT: Record<CITone, string> = { pass: 'text-ok', fail: 'text-danger', norunner: 'text-norunner', running: 'text-warn', queued: 'text-fg-muted', skipped: 'text-fg-faint' }
const DELTA: Record<DeltaTone, string> = { warn: 'text-warn', ok: 'text-ok', muted: 'text-fg-faint' }

/** One state's group: its circle, the count and, but for passed beside others, the word. */
function Part({ tone, n, word = true }: { tone: CITone; n: number; word?: boolean }) {
  return (
    <span data-check-part={tone} title={tone === 'norunner' ? NO_RUNNER_TITLE : undefined} className={`inline-flex shrink-0 items-center gap-1 ${TEXT[tone]}`}>
      <StateMark tone={tone} />
      <span><span className="num">{n}</span>{word ? ` ${WORD[tone]}` : ''}</span>
    </span>
  )
}

/** The most circles a row draws; the rest are counted, and the hover lists them all. */
const CIRCLES_MAX = 24

/** A circle per check, in the order they started; each one a button that hands its check to the caller. */
function Circles({ s, onPick }: { s: ChecksSummary; onPick?: (n: PipeNode) => void }) {
  const shown = s.started.length > CIRCLES_MAX ? s.started.slice(0, CIRCLES_MAX - 1) : s.started
  const more = s.started.length - shown.length
  const time = shortRun(s.ms)
  return (
    <>
      <span data-check-circles className="inline-flex shrink-0 items-center">
        {shown.map((n) => (
          <button key={n.key} type="button" data-pipe-node={n.jobId ?? n.key} data-tone={n.tone} aria-label={`${n.name}: ${WORD[n.tone]}`}
            tabIndex={-1} disabled={!onPick && !n.url}
            onClick={(e) => { e.stopPropagation(); onPick?.(n) }}
            className="flex h-[14px] w-[11px] items-center justify-center rounded-full hover:brightness-125 disabled:cursor-default">
            <span aria-hidden className="pipe-node" data-size="sm" data-tone={n.tone} />
          </button>
        ))}
        {more > 0 && <span className="num ml-1 text-[10.5px] text-fg-faint">+{more}</span>}
      </span>
      {time && <span className="shrink-0 text-fg-faint">· <span className="num">{time}</span></span>}
    </>
  )
}

/**
 * The folded line's bar (owner, 2026-11-19): a segment per check, coloured
 * by its state, failed at the left edge (lib/ci checkBar); too many to tell
 * apart, the same order fills the bar in proportion. Decorative: the
 * summary's accessible name says it in words.
 */
export function CheckBarMark({ s, width }: { s: ChecksSummary; width: number }) {
  const b = checkBar(s.counts, width)
  if (b.total === 0) return null
  return (
    <span aria-hidden data-check-bar={b.mode} style={{ width, gap: b.mode === 'segments' ? CHECK_BAR_GAP : 0 }}
      className={`check-bar flex h-[6px] shrink-0 overflow-hidden${b.mode === 'fill' ? ' rounded-[2px]' : ''}`}>
      {b.mode === 'segments'
        ? b.parts.flatMap((p) => Array.from({ length: p.n }, (_, i) => <i key={`${p.tone}${i}`} data-tone={p.tone} className="check-bar-seg flex-1 rounded-[2px]" />))
        : b.parts.map((p) => <i key={p.tone} data-tone={p.tone} className="check-bar-seg" style={{ flex: `${p.n} 1 0` }} />)}
    </span>
  )
}

const BAR_TEXT: Record<CheckBarWord['tone'], string> = { ...TEXT, queued: 'text-fg-muted', pass: 'text-fg-muted', count: 'text-fg-muted', time: 'text-fg-faint' }

/** The words after the bar: "11/13 · 2 running · 5m"; `words: false` keeps the figures alone. */
function BarWords({ s, skips, words = true }: { s: ChecksSummary; skips: boolean; words?: boolean }) {
  const ws = checkBarWords(s).filter((w) => (skips || w.tone !== 'skipped') && (words || (w.tone !== 'time' && w.tone !== 'skipped')))
  return (
    <span className="inline-flex shrink-0 items-baseline">
      {ws.map((w, i) => {
        const tone = w.tone === 'pass' && s.green ? 'font-medium text-ok' : BAR_TEXT[w.tone]
        const text = words ? w.text : w.text.split(' ')[0]
        const part = w.tone === 'count' || w.tone === 'time' ? undefined : w.tone
        return (
          <span key={w.tone} className="inline-flex shrink-0 items-baseline">
            {i > 0 && <span className="whitespace-pre text-fg-faint"> · </span>}
            <span data-check-part={part} data-check-count={w.tone === 'count' || undefined} title={w.tone === 'norunner' ? NO_RUNNER_TITLE : undefined} className={`tabular-nums ${tone}`}>{text}</span>
          </span>
        )
      })}
    </span>
  )
}

/** How long the pointer rests on a summary in the cockpit before its list opens. */
export const BESIDE_DELAY_MS = 600

/**
 * focusable: false inside a control of its own (the cockpit block is one button), so focus lands once.
 * beside: the cockpit's way (owner, 2026-10-14, translated: "you can't move the mouse here — on hover
 * a modal opens and you can't see anything"): the list opens only once the pointer has rested on the
 * summary for BESIDE_DELAY_MS, never while it passes over; it stands outside the panel, left of the
 * element marked `data-checks-edge`, so it never covers the rows; and it closes the moment the
 * pointer leaves, taking no pointer itself.
 */
/**
 * How much of the summary a narrow row has room for (CockpitCI's folded
 * line, through FitSummary; owner, 2026-11-18: "#941 ✕ 1 failed ● 1 running
 * ✓ 12 · 2 skipped" ran past the panel's edge): `full`, then `noskip` (no
 * "· N skipped"), then `compact` (the marks and their counts, no words, no
 * time), then `worst` (the worst state alone, its mark and word).
 */
export type CheckFit = 'full' | 'noskip' | 'compact' | 'worst'

/**
 * bar: the folded CI line's way (owner, 2026-11-19): the segmented bar this
 * many pixels wide, then the count — "1/1 passed", "11/13 · 2 running · 5m",
 * "1 failed · 12/13". `fit` shortens it the same way: the skipped count
 * goes, then the words, then all but the worst state's word.
 */
export function CheckSummary({ s, label, onPick, focusable = true, className = '', view = 'summary', beside = false, fit = 'full', bar }: { s: ChecksSummary; label: string; onPick?: (n: PipeNode) => void; focusable?: boolean; className?: string; view?: ChecksView; beside?: boolean; fit?: CheckFit; bar?: number }) {
  const c = s.counts
  const anchor = useRef<HTMLSpanElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const shut = useRef<number | undefined>(undefined)
  const show = () => {
    window.clearTimeout(shut.current)
    if (beside) shut.current = window.setTimeout(() => setOpen(true), BESIDE_DELAY_MS)
    else setOpen(true)
  }
  const hide = () => {
    window.clearTimeout(shut.current)
    if (beside) setOpen(false)
    else shut.current = window.setTimeout(() => setOpen(false), 120)
  }
  useEffect(() => () => window.clearTimeout(shut.current), [])
  // Focused, the keys scroll the open list: the cockpit's card takes no
  // pointer, so a list cut to the window's height scrolls from here.
  const keys = (e: KeyboardEvent) => {
    const l = scroller.current
    if (!open || !l || l.scrollHeight <= l.clientHeight) return
    const step = ({ ArrowDown: 40, ArrowUp: -40, PageDown: l.clientHeight - 24, PageUp: 24 - l.clientHeight, End: l.scrollHeight, Home: -l.scrollHeight } as Record<string, number>)[e.key]
    if (step === undefined) return
    e.preventDefault()
    l.scrollTop += step
  }
  const sentence = checksSentence(s)
  const time = shortRun(s.ms)
  const skips = fit === 'full'
  const worst: CITone = c.fail ? 'fail' : c.norunner ? 'norunner' : c.running ? 'running' : c.queued ? 'queued' : c.pass ? 'pass' : 'skipped'
  const body = view === 'circles' ? <Circles s={s} onPick={onPick} /> : bar !== undefined ? (
    <>
      <CheckBarMark s={s} width={bar} />
      {fit === 'worst'
        ? <span data-check-part={worst} title={worst === 'norunner' ? NO_RUNNER_TITLE : undefined} className={TEXT[worst]}>{WORD[worst]}</span>
        : <BarWords s={s} skips={skips} words={fit !== 'compact'} />}
    </>
  ) : fit === 'worst' ? (
    <span data-check-part={worst} title={worst === 'norunner' ? NO_RUNNER_TITLE : undefined} className={`inline-flex shrink-0 items-center gap-1 ${TEXT[worst]}`}><StateMark tone={worst} /><span>{WORD[worst]}</span></span>
  ) : fit === 'compact' ? (
    <>
      {c.fail > 0 && <Part tone="fail" n={c.fail} word={false} />}
      {c.norunner > 0 && <Part tone="norunner" n={c.norunner} word={false} />}
      {c.running > 0 && <Part tone="running" n={c.running} word={false} />}
      {c.queued > 0 && <Part tone="queued" n={c.queued} word={false} />}
      {c.pass > 0 && <Part tone="pass" n={c.pass} word={false} />}
    </>
  ) : s.green ? (
    <>
      <span data-check-part="pass" className="inline-flex shrink-0 items-center gap-1 font-medium text-ok">
        <StateMark tone="pass" />
        <span>{c.skipped ? <><span className="num">{c.pass}</span> passed</> : <>all <span className="num">{c.pass}</span></>}</span>
      </span>
      {time && <span className="shrink-0 text-fg-muted">· <span className="num">{time}</span></span>}
      {s.vs?.kind === 'delta' && <span className={`num shrink-0 ${DELTA[s.vs.tone]}`}>{s.vs.text}</span>}
      {skips && c.skipped > 0 && <span data-check-part="skipped" className="shrink-0 text-fg-faint">· {c.skipped} skipped</span>}
    </>
  ) : (
    <>
      {c.fail > 0 && <Part tone="fail" n={c.fail} />}
      {c.norunner > 0 && <Part tone="norunner" n={c.norunner} />}
      {c.running > 0 && <Part tone="running" n={c.running} />}
      {c.queued > 0 && <Part tone="queued" n={c.queued} />}
      {c.pass > 0 && <Part tone="pass" n={c.pass} word={c.fail + c.norunner + c.running + c.queued === 0} />}
      {skips && c.skipped > 0 && <span data-check-part="skipped" className="shrink-0 text-fg-faint">{c.pass + c.fail + c.norunner + c.running + c.queued > 0 ? '· ' : ''}{c.skipped} skipped</span>}
      {!s.done && time && <span className="shrink-0 text-fg-faint">· <span className="num">{time}</span></span>}
    </>
  )
  return (
    <span ref={anchor} data-check-summary={s.green ? 'green' : c.fail ? 'fail' : c.norunner && s.done ? 'norunner' : s.done ? 'done' : 'running'} data-check-view={view} data-check-fit={fit === 'full' ? undefined : fit} data-check-bar-w={bar} tabIndex={focusable ? 0 : undefined}
      role={view === 'circles' ? 'group' : 'img'} aria-label={`${label}: ${sentence}`}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onKeyDown={keys}
      className={`inline-flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[4px] text-[11.5px] outline-none focus-visible:ring-1 focus-visible:ring-accent ${className}`}>
      {body}
      {open && <CheckList s={s} label={label} anchor={anchor} scroller={scroller} onEnter={beside ? undefined : show} onLeave={beside ? undefined : hide} onPick={onPick} beside={beside} />}
    </span>
  )
}

/** The most checks the hover lists; the rest are counted. */
const LIST_MAX = 30

/** Every check of the PR, in a card beside the summary, drawn in the page's body so a scrolling list never clips it. */
function CheckList({ s, label, anchor, scroller, onEnter, onLeave, onPick, beside }: { s: ChecksSummary; label: string; anchor: RefObject<HTMLSpanElement | null>; scroller: RefObject<HTMLDivElement | null>; onEnter?: () => void; onLeave?: () => void; onPick?: (n: PipeNode) => void; beside?: boolean }) {
  const card = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden', left: 0, top: 0 })
  // Measured, then placed so the whole card stays in the window
  // (lib/popoverPlace): under or over the summary, or beside the panel and
  // lifted off the window's foot; taller than the window, its list scrolls
  // under a header that stays. Placed again as the page scrolls or resizes.
  const place = useCallback(() => {
    const a = anchor.current, c = card.current, l = scroller.current
    if (!a || !c || !l) return
    const r = a.getBoundingClientRect()
    const vp = { w: window.innerWidth, h: window.innerHeight }
    const size = { w: c.offsetWidth, h: c.offsetHeight - l.clientHeight + l.scrollHeight }
    const edge = beside ? a.closest('[data-checks-edge]')?.getBoundingClientRect() : undefined
    const p = beside ? placeBeside(r, edge ? edge.left : r.left, size, vp) : placeNear(r, size, vp)
    c.dataset.side = p.side
    setPos((was) => (was.left === p.left && was.top === p.top && was.maxHeight === p.maxHeight && was.visibility === undefined ? was : { left: p.left, top: p.top, maxHeight: p.maxHeight }))
  }, [anchor, scroller, beside])
  useLayoutEffect(place, [place, s])
  useEffect(() => {
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [place])
  const shown = s.nodes.slice(0, LIST_MAX)
  const more = s.nodes.length - shown.length
  const timeLine = s.ms ? (s.done ? `took ${fmtRun(s.ms)}` : `running for ${fmtRun(s.ms)}`) : ''
  return createPortal(
    <div ref={card} role="tooltip" data-check-list data-beside={beside || undefined} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', zIndex: 60, pointerEvents: beside ? 'none' : undefined, ...pos }}
      className="flex w-[min(380px,calc(100vw-16px))] flex-col overflow-hidden rounded-lg border border-border-strong bg-panel py-2 text-[11.5px] shadow-lg">
      <div data-check-list-head className="shrink-0 px-2.5">
        <div className="text-[12px] font-medium text-fg">{label}</div>
        <div className="mb-1.5 text-fg-muted">{checksSentence(s)}{timeLine ? ` · ${timeLine}` : ''}</div>
        {s.vs && <div className="-mt-1 mb-1.5 text-fg-faint">{s.vs.title}</div>}
      </div>
      <div ref={scroller} data-check-list-scroll className="min-h-0 overflow-y-auto px-2.5">
        <ul className="grid grid-cols-[10px_minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-[3px]">
          {shown.map((n) => (
            <li key={n.key} className="contents">
              <StateMark tone={n.tone} />
              <button type="button" data-check-row={n.jobId ?? n.key} data-tone={n.tone} disabled={!onPick && !n.url} onClick={() => onPick?.(n)}
                className="min-w-0 truncate text-left text-fg hover:underline disabled:cursor-default disabled:hover:no-underline" title={n.name}>
                {nodeBaseName(n)}
              </button>
              <span className="text-fg-faint">{osName(n.os)}</span>
              <span className={TEXT[n.tone]}>{WORD[n.tone]}</span>
              <span className="num text-right text-fg-muted">{n.ms !== undefined ? fmtRun(n.ms) : ''}</span>
              {n.step && <span data-check-step className="col-span-4 col-start-2 -mt-[2px] truncate text-[11px] text-danger" title={n.step}>failed at {n.step}</span>}
              {n.tone === 'norunner' && <span data-check-norunner className="col-span-4 col-start-2 -mt-[2px] text-[11px] text-norunner">{NO_RUNNER_TITLE}</span>}
            </li>
          ))}
        </ul>
        {more > 0 && <div className="mt-1 text-fg-faint">+{more} more</div>}
      </div>
    </div>,
    document.body,
  )
}
