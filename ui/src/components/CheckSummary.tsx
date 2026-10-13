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
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { checksSentence, fmtRun, nodeBaseName, osName, shortRun, type CITone, type ChecksSummary, type ChecksView, type DeltaTone, type PipeNode } from '@/lib/ci'

/** A state's circle: ✓ on green, ✗ on red, amber pulsing while running, hollow queued, a slash skipped. */
export function StateMark({ tone }: { tone: CITone }) {
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

const WORD: Record<CITone, string> = { pass: 'passed', fail: 'failed', running: 'running', queued: 'queued', skipped: 'skipped' }
const TEXT: Record<CITone, string> = { pass: 'text-ok', fail: 'text-danger', running: 'text-warn', queued: 'text-fg-muted', skipped: 'text-fg-faint' }
const DELTA: Record<DeltaTone, string> = { warn: 'text-warn', ok: 'text-ok', muted: 'text-fg-faint' }

/** One state's group: its circle, the count and, but for passed beside others, the word. */
function Part({ tone, n, word = true }: { tone: CITone; n: number; word?: boolean }) {
  return (
    <span data-check-part={tone} className={`inline-flex shrink-0 items-center gap-1 ${TEXT[tone]}`}>
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

/** focusable: false inside a control of its own (the cockpit block is one button), so focus lands once. */
export function CheckSummary({ s, label, onPick, focusable = true, className = '', view = 'summary' }: { s: ChecksSummary; label: string; onPick?: (n: PipeNode) => void; focusable?: boolean; className?: string; view?: ChecksView }) {
  const c = s.counts
  const anchor = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const shut = useRef<number | undefined>(undefined)
  const show = () => { window.clearTimeout(shut.current); setOpen(true) }
  const hide = () => { window.clearTimeout(shut.current); shut.current = window.setTimeout(() => setOpen(false), 120) }
  useEffect(() => () => window.clearTimeout(shut.current), [])
  const sentence = checksSentence(s)
  const time = shortRun(s.ms)
  const body = view === 'circles' ? <Circles s={s} onPick={onPick} /> : s.green ? (
    <>
      <span data-check-part="pass" className="inline-flex shrink-0 items-center gap-1 font-medium text-ok">
        <StateMark tone="pass" />
        <span>{c.skipped ? <><span className="num">{c.pass}</span> passed</> : <>all <span className="num">{c.pass}</span></>}</span>
      </span>
      {time && <span className="shrink-0 text-fg-muted">· <span className="num">{time}</span></span>}
      {s.vs?.kind === 'delta' && <span className={`num shrink-0 ${DELTA[s.vs.tone]}`}>{s.vs.text}</span>}
      {c.skipped > 0 && <span data-check-part="skipped" className="shrink-0 text-fg-faint">· {c.skipped} skipped</span>}
    </>
  ) : (
    <>
      {c.fail > 0 && <Part tone="fail" n={c.fail} />}
      {c.running > 0 && <Part tone="running" n={c.running} />}
      {c.queued > 0 && <Part tone="queued" n={c.queued} />}
      {c.pass > 0 && <Part tone="pass" n={c.pass} word={c.fail + c.running + c.queued === 0} />}
      {c.skipped > 0 && <span data-check-part="skipped" className="shrink-0 text-fg-faint">{c.pass + c.fail + c.running + c.queued > 0 ? '· ' : ''}{c.skipped} skipped</span>}
      {!s.done && time && <span className="shrink-0 text-fg-faint">· <span className="num">{time}</span></span>}
    </>
  )
  return (
    <span ref={anchor} data-check-summary={s.green ? 'green' : c.fail ? 'fail' : s.done ? 'done' : 'running'} data-check-view={view} tabIndex={focusable ? 0 : undefined}
      role={view === 'circles' ? 'group' : 'img'} aria-label={`${label}: ${sentence}`}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
      className={`inline-flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[4px] text-[11.5px] outline-none focus-visible:ring-1 focus-visible:ring-accent ${className}`}>
      {body}
      {open && <CheckList s={s} label={label} anchor={anchor} onEnter={show} onLeave={hide} onPick={onPick} />}
    </span>
  )
}

/** The most checks the hover lists; the rest are counted. */
const LIST_MAX = 30

/** Every check of the PR, in a card beside the summary, drawn in the page's body so a scrolling list never clips it. */
function CheckList({ s, label, anchor, onEnter, onLeave, onPick }: { s: ChecksSummary; label: string; anchor: RefObject<HTMLSpanElement | null>; onEnter: () => void; onLeave: () => void; onPick?: (n: PipeNode) => void }) {
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect()
    if (!r) return
    const vw = window.innerWidth, vh = window.innerHeight
    const right = Math.max(8, vw - r.right - 8)
    const above = r.top > vh - r.bottom
    setPos(above ? { right, bottom: vh - r.top + 6, maxHeight: r.top - 14 } : { right, top: r.bottom + 6, maxHeight: vh - r.bottom - 14 })
  }, [anchor])
  const shown = s.nodes.slice(0, LIST_MAX)
  const more = s.nodes.length - shown.length
  const timeLine = s.ms ? (s.done ? `took ${fmtRun(s.ms)}` : `running for ${fmtRun(s.ms)}`) : ''
  return createPortal(
    <div role="tooltip" data-check-list onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', zIndex: 60, ...pos }}
      className="w-[min(380px,calc(100vw-16px))] overflow-y-auto rounded-lg border border-border-strong bg-panel px-2.5 py-2 text-[11.5px] shadow-lg">
      <div className="text-[12px] font-medium text-fg">{label}</div>
      <div className="mb-1.5 text-fg-muted">{checksSentence(s)}{timeLine ? ` · ${timeLine}` : ''}</div>
      {s.vs && <div className="-mt-1 mb-1.5 text-fg-faint">{s.vs.title}</div>}
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
          </li>
        ))}
      </ul>
      {more > 0 && <div className="mt-1 text-fg-faint">+{more} more</div>}
    </div>,
    document.body,
  )
}
