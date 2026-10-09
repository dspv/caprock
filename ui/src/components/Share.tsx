/**
 * Share these numbers — from anywhere, in one click.
 *
 * The card could only be drawn from one panel on one screen, and drawing it
 * only saved a PNG: posting it meant finding the file, opening a social site
 * and writing the words yourself. Three steps, two of them chores.
 *
 * What a browser can actually do about that is limited, and the limit shapes
 * this component:
 *
 *  - **Web Share API** (`navigator.share` with `files`) hands the image
 *    straight to the operating system's share sheet — the real thing, on a
 *    phone and on recent desktop Safari. When it exists, that is the whole
 *    interaction: one click, pick an app, done.
 *  - **Everywhere else** a social site cannot be handed an image by URL; no
 *    amount of query string will attach a picture to a tweet. So the fallback
 *    downloads the card and opens the site with the text already written,
 *    leaving one drag to do. Saying that out loud beats a button that appears
 *    to post and does not.
 *
 * The card itself carries `caprock.dev`, so the link travels with the image
 * even when someone posts it without the text.
 */
import { useEffect, useRef, useState } from 'react'
import { useApi } from '@/lib/useApi'
import { api, type Week } from '@/lib/api'
import { cardFilename, drawShareCard, PERIOD_LABEL, screenLook, STEP_LABEL, type CardData, type CardLook, type CardStep, type SharePeriod } from './ShareCard'
import { CARD_SIZE, WeekCard, type CardLayout } from './WeekCard'
import { Scaled } from './Scaled'
import { renderCardPNG } from '@/lib/cardimage'
import { openExternal } from '@/lib/nudges'
import { CloseButton, DialogBackdrop } from './Dialog'
import { periodWords } from '@/lib/week'
import { currentFigures, currentStory, fetchFigures, fetchStory, FRESH_MS, lastFigures, lastStory, warmShare } from '@/lib/sharecache'

export function ShareButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* Visible, not loud (owner, 2026-10-10).
        *
        * It was a solid amber block, filled after an outline lost to the
        * premium button beside it — and then it was the loudest thing in the
        * header, louder than the figures it shares. A tinted pill with the
        * share icon is found without reading the row and does not shout:
        * the accent at a sixth of its strength, its border at two fifths,
        * the label in the accent itself. */}
      <button
        onClick={() => setOpen(true)}
        // The default card's figures start loading on the way to the click.
        onMouseEnter={warmShare}
        onFocus={warmShare}
        className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/15 px-2.5 py-[3px] text-[12px] font-medium text-accent transition-colors hover:bg-accent/25"
        title="Draw a shareable picture of your figures"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
          <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
        </svg>
        Share
      </button>
      {open && <ShareDialog onClose={() => setOpen(false)} />}
    </>
  )
}

type Style = 'figures' | 'story'

const STYLE_KEY = 'caprock-share-style'
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

/** The period as the story card's progress line says it. */
const PERIOD_WORDS: Record<SharePeriod, string> = {
  today: 'today',
  '7d': 'this week',
  '30d': 'this month',
  all: 'all time',
}

export function ShareDialog({ onClose, initialPeriod = '7d' }: { onClose: () => void; initialPeriod?: SharePeriod }) {
  // Two separate things, and conflating them produced two cards.
  //
  // `drawing` is "the card is being made" — that is what the label reports,
  // and it ends when the PNG exists. `locked` is "this dialog has already
  // started something" — it must outlast the label, because the OS share
  // sheet stays open long after the drawing is done. When one flag did both,
  // clearing it to fix the stuck "preparing…" also re-enabled the button
  // underneath the open share sheet, and a second click drew a second card.
  const [drawing, setDrawing] = useState(false)
  const [locked, setLocked] = useState(false)
  const [note, setNote] = useState('')
  // Which stretch the card is about. Defaults to the week: a working week is
  // the thing people actually finish and want to show, and an all-time total
  // shared on its own reads as a boast rather than a result.
  const [period, setPeriod] = useState<SharePeriod>(initialPeriod)
  // Figures: the dense card of totals. Story: the Week screen's card — a
  // headline, the money beside it, who did what, the longest loop — for any
  // of the four periods.
  const [style, setStyleState] = useState<Style>(() => remembered(STYLE_KEY, ['figures', 'story'] as const, 'figures'))
  const [layout, setLayoutState] = useState<CardLayout>(() => remembered(LAYOUT_KEY, ['land', 'port'] as const, 'land'))
  // The ground the card is drawn on: the screen's by default, remembered once
  // chosen. A dark card stands out in a light feed and the paper one matches
  // caprock.dev, so it is the poster's choice, not the dashboard's theme.
  const [look, setLookState] = useState<CardLook>(() => remembered(LOOK_KEY, ['dark', 'paper'] as const, screenLook()))
  const setLook = (l: CardLook) => { setLookState(l); remember(LOOK_KEY, l) }
  const setStyle = (s: Style) => { setStyleState(s); remember(STYLE_KEY, s) }
  const setLayout = (l: CardLayout) => { setLayoutState(l); remember(LAYOUT_KEY, l) }

  // The Figures picture, drawn as soon as the sheet opens and again whenever
  // the period changes.
  //
  // Without it the period buttons are a promise about a file nobody has seen:
  // you press Save, open your downloads, and only then find out what you
  // chose. A card is a picture — the way to choose one is to look at it.
  const [preview, setPreview] = useState<string>('')
  // The Story card's figures; drawn as a live card rather than an image.
  const [story, setStory] = useState<Week | undefined>(undefined)
  // What is on screen is the last reading, and the current one is on its way.
  const [stale, setStale] = useState<number>(0)
  // Nothing kept for this period: the card on screen (if any) is another
  // period's, so the progress is drawn over it until this one lands.
  const [waiting, setWaiting] = useState(false)
  // Whether the last fetch gave up with nothing to show, so the box can say so
  // instead of waiting.
  const [failed, setFailed] = useState(false)
  // Which ranges have answered, and since when the dialog has been waiting —
  // the progress shown while there is no card yet.
  const [steps, setSteps] = useState<Set<CardStep>>(new Set())
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const card = useRef<HTMLElement>(null)

  // Figures. The last reading for the period is drawn at once (a canvas draw
  // is milliseconds); the current one is fetched behind it and replaces it.
  //
  // The revoke has to happen when the *replacement* is on screen, not when the
  // effect tears down. Revoking in cleanup looked tidy and broke the feature:
  // changing period ran the old cleanup immediately, which revoked the URL the
  // <img> was still pointing at, and a revoked blob leaves the already-decoded
  // bitmap showing. Every period drew a correct new card that nobody ever saw —
  // the preview simply never changed.
  useEffect(() => {
    if (style !== 'figures') return
    let live = true
    let freshShown = false
    const show = (url: string) => setPreview((prev) => {
      // The old bitmap is only unreachable once the new src is in place, so
      // this is the one safe moment to let it go.
      if (prev && prev !== url) URL.revokeObjectURL(prev)
      return url
    })
    const draw = async (d: CardData, fresh: boolean) => {
      let blob: Blob | null = null
      try { blob = await drawShareCard(d, look) } catch { blob = null }
      if (!live || (!fresh && freshShown)) return false
      if (!blob) return false
      if (fresh) freshShown = true
      show(URL.createObjectURL(blob))
      return true
    }
    const kept = lastFigures(period)
    setFailed(false)
    setStartedAt(Date.now())
    setSteps(new Set())
    setWaiting(!kept)
    // With nothing kept, the previous period's card stays under the progress
    // until this one is drawn: clearing it would release a URL the <img> still
    // shows, and the swap below is the one safe moment for that.
    if (kept) void draw(kept.value, false)
    if (kept && Date.now() - kept.at < FRESH_MS) { setStale(0); return () => { live = false } }
    setStale(kept ? kept.at : 0)
    fetchFigures(period, (done) => { if (live) setSteps(done) })
      .then(async (d) => {
        const ok = await draw(d, true)
        if (!live) return
        setStale(0)
        setWaiting(false)
        // "drawing…" is a state that ends. Without this it was also the state
        // for "this will never draw", which is the same screen forever and no
        // way to tell the two apart.
        if (!ok && !kept) setFailed(true)
      })
      .catch(() => {
        if (!live) return
        setStale(0)
        setWaiting(false)
        if (!kept) setFailed(true)
      })
    return () => { live = false }
  }, [period, style, look])

  // Story: the same — last figures at once, current behind them.
  useEffect(() => {
    if (style !== 'story') return
    let live = true
    const kept = lastStory(period)
    setStory(kept?.value)
    setWaiting(false)
    setFailed(false)
    setStartedAt(Date.now())
    setSteps(new Set())
    if (kept && Date.now() - kept.at < FRESH_MS) { setStale(0); return () => { live = false } }
    setStale(kept ? kept.at : 0)
    fetchStory(period)
      .then((w) => { if (live) { setStory(w); setStale(0) } })
      .catch(() => { if (live) { setStale(0); if (!kept) setFailed(true) } })
    return () => { live = false }
  }, [period, style])

  // The last URL outlives the effect that made it, so releasing it belongs to
  // the component's own unmount rather than to any one draw. Held in a ref
  // because unmount cleanup must not set state — it reads the current value
  // and frees it, nothing more.
  const latest = useRef('')
  latest.current = preview
  useEffect(() => () => {
    if (latest.current) URL.revokeObjectURL(latest.current)
  }, [])

  const size = CARD_SIZE[layout]
  const fileName = () => style === 'figures'
    ? cardFilename()
    : cardFilename().replace('caprock-', `caprock-${period}-${size.w}x${size.h}-`)

  /**
   * The image that leaves the machine, always from the current figures. When
   * the screen shows an earlier reading, this waits for the current one first.
   */
  const build = async (): Promise<Blob | null> => {
    if (style === 'figures') return drawShareCard(await currentFigures(period), look)
    const w = await currentStory(period)
    setStory(w)
    setStale(0)
    await settled()
    if (!card.current) return null
    return renderCardPNG(card.current, size)
  }

  /** The good path: hand the file to the OS and let it offer every app. */
  const shareNative = async () => {
    if (locked) return
    setLocked(true); setDrawing(true); setNote('')
    try {
      const blob = await build()
      if (!blob) { setNote('Could not draw the card in this browser.'); setLocked(false); return }
      const file = new File([blob], fileName(), { type: 'image/png' })
      // The label stops saying "drawing" here, because the drawing is done.
      // The button stays disabled, because the share sheet is about to open
      // and pressing again behind it would draw a second card.
      setDrawing(false)
      // The file travels alone.
      //
      // Sending `{files, text}` together looks like a courtesy — the picture
      // plus a caption to paste with it — but the receiving app decides what
      // to do with two payloads, and several of them treat it as two items:
      // the owner pressed Copy in the macOS share sheet and got the card
      // twice. The card already carries every figure and the caveat, so the
      // caption was never load-bearing; the image is the share.
      await navigator.share({ files: [file] })
      onClose()
    } catch (e) {
      // A cancelled share sheet is not an error worth reporting — but it does
      // hand the dialog back, so the buttons have to work again.
      if ((e as Error)?.name !== 'AbortError') setNote('Sharing was not available — the card was not sent.')
      setLocked(false)
    } finally { setDrawing(false) }
  }

  /** The fallback: save the image to downloads. */
  const save = async () => {
    if (locked) return
    setLocked(true); setDrawing(true); setNote('')
    try {
      const blob = await build()
      if (!blob) { setNote('Could not draw the card in this browser.'); return }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName()
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setNote('Saved to your downloads.')
    } catch {
      setNote('Could not read the figures — nothing was saved.')
    } finally { setDrawing(false); setLocked(false) }
  }

  /**
   * Put the card on the clipboard, to paste into a post or a chat. Returns
   * whether it got there: a browser without image clipboard support (or a
   * page that is not focused) refuses, and the caller says so.
   */
  const copyBlob = async (blob: Blob): Promise<boolean> => {
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return true
    } catch {
      return false
    }
  }

  const copy = async () => {
    if (locked) return
    setLocked(true); setDrawing(true); setNote('')
    try {
      const blob = await build()
      if (!blob) { setNote('Could not draw the card in this browser.'); return }
      setNote(await copyBlob(blob) ? 'Copied — paste it anywhere.' : 'This browser would not copy an image. Save the image instead.')
    } catch {
      setNote('Could not read the figures — nothing was copied.')
    } finally { setDrawing(false); setLocked(false) }
  }

  /**
   * X cannot be handed an image by URL, so this copies the card (or saves it
   * when copying is refused) and opens a post with the words written; the
   * image is one paste away. The note says exactly that.
   */
  const postX = async () => {
    if (locked) return
    setLocked(true); setDrawing(true); setNote('')
    try {
      const blob = await build()
      let how = 'Opened X with the text.'
      if (blob && await copyBlob(blob)) how = 'Opened X with the text — the card is on your clipboard, paste it in.'
      else if (blob) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = fileName()
        document.body.appendChild(a); a.click(); a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
        how = 'Opened X with the text — the card is in your downloads, drag it in.'
      }
      openExternal(xIntent(period))
      setNote(how)
    } catch {
      setNote('Could not read the figures — nothing was posted.')
    } finally { setDrawing(false); setLocked(false) }
  }

  const canNative = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [new File([], 'x.png', { type: 'image/png' })] })

  const words = periodWords(period)
  const storyEmpty = style === 'story' && !!story && story.sessions === 0
  const aspect = style === 'figures' ? '1200 / 630' : `${size.w} / ${size.h}`
  const progressSteps = style === 'figures'
    ? (['totals', 'agents', 'plan'] as CardStep[]).map((k) => ({ label: STEP_LABEL[k], done: steps.has(k) }))
    : [{ label: `Counting PRs, commits and loops — ${PERIOD_WORDS[period]}`, done: false }]

  const seg = (on: boolean) => `rounded-[5px] px-2.5 py-1 text-[12px] transition-colors ${on ? 'bg-panel text-fg font-medium shadow-sm' : 'text-fg-muted hover:text-fg'}`
  const group = 'inline-flex items-center gap-0.5 rounded-md border border-border bg-panel-2 p-0.5'
  const quiet = 'rounded-md border border-border px-3 py-2 text-[13px] text-fg transition-colors hover:border-border-strong hover:bg-panel-2 disabled:opacity-50'
  const primary = 'rounded-md bg-accent px-4 py-2.5 text-[14px] font-semibold text-bg transition hover:brightness-110 disabled:opacity-50'

  return (
    <DialogBackdrop
      onClose={onClose}
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/55 px-4 py-[6vh]"
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
              <div className={group} role="group" aria-label="Card style">
                <button onClick={() => setStyle('figures')} aria-pressed={style === 'figures'} className={seg(style === 'figures')} title="One figure, said big">Figures</button>
                <button onClick={() => setStyle('story')} aria-pressed={style === 'story'} className={seg(style === 'story')} title="Who did what, the longest loop, the biggest session">Story</button>
              </div>
              <div className={group} role="group" aria-label="Card look">
                {(['dark', 'paper'] as CardLook[]).map((l) => (
                  <button key={l} onClick={() => setLook(l)} aria-pressed={look === l} className={seg(look === l)}>
                    {l === 'dark' ? 'Dark' : 'Paper'}
                  </button>
                ))}
              </div>
              {style === 'story' && (
                <div className={group} role="group" aria-label="Card size">
                  {(['land', 'port'] as CardLayout[]).map((l) => (
                    <button key={l} onClick={() => setLayout(l)} aria-pressed={layout === l} className={seg(layout === l)}
                      title={`${CARD_SIZE[l].w}×${CARD_SIZE[l].h}`}>
                      {l === 'land' ? 'Landscape' : 'Portrait'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* The card, as big as the sheet allows. It is the thing being
            * decided — the buttons only choose where it goes. A fixed aspect
            * box so switching period does not make the sheet jump while the
            * next draw lands. */}
          <div className="relative mb-4">
            {style === 'figures' ? (
              <div className="overflow-hidden rounded-[10px] border border-border bg-panel-2 shadow-[var(--shadow-panel)]" style={{ aspectRatio: aspect }}>
                {failed ? (
                  // Before the picture: a card from another period must not
                  // stand in for one that could not be drawn.
                  <Failed />
                ) : preview ? (
                  <div className="relative">
                    <img src={preview} alt="Your figures, as they will be shared" className={`block w-full ${waiting ? 'opacity-25' : ''}`} />
                    {waiting && <div className="absolute inset-0"><Progress steps={progressSteps} startedAt={startedAt} /></div>}
                  </div>
                ) : (
                  <Progress steps={progressSteps} startedAt={startedAt} />
                )}
              </div>
            ) : story && !storyEmpty ? (
              <Scaled w={size.w} h={size.h} max={layout === 'port' ? 360 : 718}>
                <WeekCard ref={card} week={story} layout={layout} when={words.when} noun={words.noun} look={look} />
              </Scaled>
            ) : (
              <div className="mx-auto overflow-hidden rounded-[10px] border border-border bg-panel-2"
                style={{ aspectRatio: aspect, maxWidth: layout === 'port' ? 360 : undefined }}>
                {storyEmpty ? (
                  <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-fg-muted">
                    Nothing ran {words.when.replace('— ', '')} on this machine, so there is no story to tell yet.
                  </div>
                ) : failed ? <Failed /> : (
                  <Progress steps={progressSteps} startedAt={startedAt} />
                )}
              </div>
            )}
            {stale > 0 && (preview || story) && (
              <div className="absolute right-2 top-2 rounded-sm bg-panel/90 px-1.5 py-0.5 text-[10.5px] text-fg-muted shadow-sm" role="status">
                from {new Date(stale).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · updating…
              </div>
            )}
          </div>

          {/* One obvious next step, filled: the operating system's share menu
            * where there is one, the clipboard where there is not — the
            * fastest way into any post or chat. Then the other ways out,
            * quiet, beside it. Hover is a fill, not a border shade: a control
            * the eye cannot confirm it is pointing at reads as disabled. */}
          <div className="flex flex-wrap items-stretch gap-2">
            {canNative ? (
              <button onClick={shareNative} disabled={locked || storyEmpty} className={`${primary} min-w-[180px] flex-1`}
                title="Opens your share menu — Messages, Mail, anywhere">
                {drawing ? 'Drawing the card…' : 'Share…'}
              </button>
            ) : (
              <button onClick={copy} disabled={locked || storyEmpty} className={`${primary} min-w-[180px] flex-1`}
                title="Puts the picture on your clipboard, to paste into a post or a chat">
                {drawing ? 'Drawing the card…' : 'Copy image'}
              </button>
            )}
            {canNative && (
              <button onClick={copy} disabled={locked || storyEmpty} className={quiet}>Copy image</button>
            )}
            <button
              onClick={save}
              disabled={locked || storyEmpty}
              title={style === 'story' ? `A ${size.w}×${size.h} PNG in your downloads` : 'A 1200×630 PNG in your downloads'}
              className={quiet}
            >
              Save image
            </button>
            <button
              onClick={postX}
              disabled={locked || storyEmpty}
              title="Opens a post on X with the text written; the card goes on your clipboard to paste in"
              className={quiet}
            >
              Post to X
            </button>
          </div>
          {note && <p className="mt-2 text-[12px] text-fg-muted" role="status">{note}</p>}

          {/* One claim per line: the reader is scanning for what does and does
            * not leave the machine, and a sentence makes them read it. */}
          <ul className="mt-4 grid gap-1 border-t border-border pt-3 text-[12.5px] text-fg-muted">
            <li>Totals only — no names, no paths, nothing Claude wrote.</li>
            <li>Drawn on your machine. Uploaded nowhere.</li>
            <li>{style === 'story' ? `A ${size.w}×${size.h} PNG` : 'A 1200×630 PNG'} · at API list prices — not a bill.</li>
            {style === 'story' && <li>≈ marks an estimate. Merged means a merge the agents ran; Caprock does not ask GitHub.</li>}
          </ul>
        </div>
      </div>
    </DialogBackdrop>
  )
}

/**
 * The X post: words and the site, no figures — the card carries those, with
 * their caveat, and a number typed into a tweet travels without it.
 */
export function xIntent(period: SharePeriod): string {
  const what = period === 'all' ? 'My Claude Code, all time' : `My Claude Code ${PERIOD_LABEL[period]}`
  const text = `${what}, measured on my own machine with Caprock — free and open source.`
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent('https://caprock.dev')}`
}

function Failed() {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-fg-faint">
      Could not draw the card here. Save the image still works — it draws again on click.
    </div>
  )
}

/**
 * What the wait looks like: the card's outline, which ranges have answered,
 * and how long it has been. An empty box saying "drawing…" read as stuck after
 * two seconds; the same wait with each step ticking off reads as work.
 */
function Progress({ steps, startedAt }: { steps: { label: string; done: boolean }[]; startedAt: number }) {
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
        <div className="mt-2 flex gap-2"><div className="h-10 flex-1 rounded-sm bg-border" /><div className="h-10 flex-1 rounded-sm bg-border" /><div className="h-10 flex-1 rounded-sm bg-border" /></div>
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-panel-2/60 px-4">
        <div className="text-[13px] font-medium text-fg">Drawing your card…</div>
        <ul className="grid gap-0.5 text-[12px]">
          {steps.map((s) => (
            <li key={s.label} className={s.done ? 'text-fg-muted' : 'text-fg-faint'}>
              <span className={`mr-1.5 inline-block w-3 text-center ${s.done ? 'text-ok' : ''}`} aria-hidden>{s.done ? '✓' : '·'}</span>
              {s.label}{s.done ? '' : '…'}
            </li>
          ))}
        </ul>
        <div className="num text-[11px] text-fg-faint">{secs.toFixed(1)} s</div>
      </div>
    </div>
  )
}

export function ShareCard() {
  const h = useApi(() => api.history('all'), [], { intervalMs: 60000 })
  const [open, setOpen] = useState(false)
  const t = h.data?.totals
  if (!t || t.sessions === 0) return null

  return (
    <>
      {/* Opens the dialog rather than downloading on the spot.
        *
        * It used to draw and save immediately: four API calls, about a second
        * of nothing, then a file in Downloads with no explanation. The owner
        * reported it as "saves slowly and it is unclear what is happening",
        * which is exactly what a silent second followed by a silent file is.
        *
        * The dialog is where the two options live and where the work is
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
