/**
 * Week: a card of what your agents did in seven days, to download or copy.
 *
 * The screen is calm and the card is the playful part. Everything is computed
 * on this machine from GET /v1/week, and the PNG is drawn in the browser from
 * the card on screen — no upload, no font fetch, nothing leaves until the user
 * posts the file themselves.
 *
 * Weeks are seven local days, the same days the Cost screen's 7d range uses;
 * the default ends today, and the arrows step a week at a time.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { addDays, rangeLabel, weekWord } from '@/lib/week'
import { Empty, Panel, Skeleton } from '@/components/ui'
import { CARD_SIZE, WeekCard, type CardLayout } from '@/components/WeekCard'
import { renderCardPNG } from '@/lib/cardimage'

const LAYOUT_KEY = 'caprock-week-layout'

function localToday(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function savedLayout(): CardLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'port' ? 'port' : 'land'
  } catch {
    return 'land'
  }
}

export function WeekScreen({ start: initial }: { start?: string } = {}) {
  const today = localToday()
  const latest = addDays(today, -6)
  const [start, setStart] = useState<string>(initial && initial <= latest ? initial : latest)
  const [layout, setLayoutState] = useState<CardLayout>(savedLayout)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const w = useApi(() => api.week(start), [start], { live: false })
  const card = useRef<HTMLElement>(null)

  const setLayout = (l: CardLayout) => {
    setLayoutState(l)
    try { localStorage.setItem(LAYOUT_KEY, l) } catch { /* a remembered layout is a convenience */ }
  }

  useEffect(() => { setNote('') }, [start, layout])

  const week = w.data && w.data.start === start ? w.data : undefined
  const empty = !!week && week.sessions === 0
  const file = `caprock-week-${start}-${layout === 'land' ? '1200x675' : '1080x1350'}.png`

  const download = async () => {
    if (!card.current) return
    setBusy(true)
    setNote('')
    try {
      const blob = await renderCardPNG(card.current, CARD_SIZE[layout])
      if (!blob) { setNote('This browser could not draw the image.'); return }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setNote(`Saved ${file} to your downloads.`)
    } catch {
      setNote('Could not draw the image.')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!card.current) return
    const Item = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
    if (!Item || !navigator.clipboard?.write) {
      setNote('This browser cannot copy images — use Download PNG.')
      return
    }
    setBusy(true)
    setNote('')
    try {
      // The promise goes into the item directly: Safari only allows a
      // clipboard write that starts inside the click, and drawing takes a
      // moment.
      const blob = renderCardPNG(card.current, CARD_SIZE[layout]).then((b) => {
        if (!b) throw new Error('no image')
        return b
      })
      await navigator.clipboard.write([new Item({ 'image/png': blob })])
      setNote('Copied — paste it into a post.')
    } catch {
      setNote('Could not copy the image — use Download PNG.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-md bg-panel-2 p-0.5" role="group" aria-label="Week">
          <button type="button" onClick={() => setStart(addDays(start, -7))}
            className="px-2 py-1 text-[12px] text-fg hover:text-accent rounded-[5px]" aria-label="Previous week">‹</button>
          {/* The label is a date field: the arrows step a week, and this picks
            * any seven days by their first one. */}
          <label className="relative px-2 text-[12px] num text-fg min-w-[150px] text-center cursor-pointer hover:text-accent">
            {rangeLabel(start, addDays(start, 6))}
            <input type="date" value={start} max={latest} aria-label="First day of the week"
              onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setStart(e.target.value <= latest ? e.target.value : latest) }}
              onClick={(e) => { try { (e.currentTarget as HTMLInputElement).showPicker?.() } catch { /* the field still works by keyboard */ } }}
              className="absolute inset-0 opacity-0 cursor-pointer w-full" />
          </label>
          <button type="button" onClick={() => setStart(addDays(start, 7))} disabled={start >= latest}
            className="px-2 py-1 text-[12px] text-fg hover:text-accent rounded-[5px] disabled:opacity-30 disabled:hover:text-fg" aria-label="Next week">›</button>
        </div>
        {start !== latest && (
          <button type="button" onClick={() => setStart(latest)} className="px-2 py-1 text-[12px] text-fg-muted hover:text-fg">
            last 7 days
          </button>
        )}
        <div className="inline-flex items-center gap-0.5 rounded-md bg-panel-2 p-0.5" role="group" aria-label="Card size">
          {(['land', 'port'] as CardLayout[]).map((l) => (
            <button key={l} type="button" onClick={() => setLayout(l)} aria-pressed={layout === l}
              className={`px-2.5 py-1 rounded-[5px] text-[12px] ${layout === l ? 'bg-accent text-panel font-medium' : 'text-fg hover:text-accent'}`}>
              {l === 'land' ? 'Landscape' : 'Portrait'}
              <span className={`ml-1.5 num text-[10px] ${layout === l ? 'text-panel/80' : 'text-fg-faint'}`}>{CARD_SIZE[l].w}×{CARD_SIZE[l].h}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" onClick={download} disabled={!week || empty || busy}
            className="px-3 py-1 rounded-md text-[12px] font-medium bg-accent text-panel hover:bg-accent-strong disabled:opacity-40">
            Download PNG
          </button>
          <button type="button" onClick={copy} disabled={!week || empty || busy}
            className="px-3 py-1 rounded-md text-[12px] border border-border-strong text-fg hover:border-accent hover:text-accent disabled:opacity-40">
            Copy image
          </button>
        </div>
      </div>

      <Panel title="Your agents, one week" right={<span className="num">{note || (week?.partial ? 'still counting — this week has not ended' : 'measured on this machine')}</span>}>
        <div className="p-3">
          {w.error && !week && <Empty title="Cannot reach the daemon">{w.error.message}</Empty>}
          {!week && !w.error && <Skeleton rows={6} />}
          {week && empty && (
            <Empty title="Nothing ran this week">
              No session on this machine recorded anything between {rangeLabel(week.start, week.end)}. Step back a week with ‹.
            </Empty>
          )}
          {week && !empty && (
            <Scaled w={CARD_SIZE[layout].w} h={CARD_SIZE[layout].h} max={layout === 'port' ? 560 : 1200}>
              <WeekCard ref={card} week={week} layout={layout} when={weekWord(week, today)} />
            </Scaled>
          )}
        </div>
      </Panel>
      <p className="text-[11px] text-fg-faint max-w-[80ch]">
        No repository, path, prompt or session title is ever on the card. Merged means a <span className="num">gh pr merge</span> the
        agents ran on this machine, in a call that did not fail — Caprock does not ask GitHub. ≈ marks estimates: lines count a whole file on every Write, and
        cost per PR divides all of the week's spend by the merges.
      </p>
    </div>
  )
}

/**
 * Shows a fixed-size card at whatever width the screen has, without changing
 * the card itself: the export reads the unscaled node, so the PNG is always
 * the full 1200 or 1080 pixels wide.
 */
function Scaled({ w, h, max, children }: { w: number; h: number; max: number; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const shown = Math.min(width || max, max)
  const scale = shown / w
  return (
    <div ref={box} className="w-full flex justify-center">
      <div style={{ width: shown, height: h * scale, overflow: 'hidden', borderRadius: 12 }} className="shadow-[var(--shadow-panel)]">
        <div style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: 'top left' }}>{children}</div>
      </div>
    </div>
  )
}
