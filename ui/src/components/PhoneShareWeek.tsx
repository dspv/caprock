/**
 * Share your week, from the phone (.ai/04-ui.md § The phone home, owner
 * 2026-10-27: "do both", translated). One quiet row near the foot of the
 * phone home opens a sheet with the same Week card the computer draws
 * (WeekCard, portrait — a phone's feed is tall), and one button that hands
 * the PNG to the operating system's share menu (`navigator.share({files})`).
 * On an iPhone that menu lists Threads, X, Messages and the rest, and the
 * card arrives attached, so nothing is pasted and nothing is uploaded: the
 * picture goes from this phone straight to the app the person picks. Where
 * the browser cannot share a file, the button saves it instead.
 *
 * The card is drawn as soon as the sheet opens, not on the tap: Safari only
 * opens the share menu from a tap that has not waited on anything, so the
 * file must be ready before the finger comes down.
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { renderCardPNG } from '@/lib/cardimage'
import { currentStory, lastStory } from '@/lib/sharecache'
import { periodWords, planOf, type CardPlan } from '@/lib/week'
import type { Week } from '@/lib/api'
import { cardFilename, screenLook, type CardLook } from './ShareCard'
import { CARD_SIZE, WeekCard } from './WeekCard'
import { Scaled } from './Scaled'
import { ShareGlyph } from './Share'
import { download } from './ShareActions'
import { BottomSheet } from './PhoneParts'
import { ChevronIcon } from './AppIcons'

/** The look the computer's sheet remembers, else the screen's. */
function rememberedLook(): CardLook {
  try {
    const v = localStorage.getItem('caprock-share-look')
    if (v === 'dark' || v === 'paper') return v
  } catch { /* the screen's, then */ }
  return screenLook()
}

/** Whether this browser can hand a PNG file to the share menu. */
export function canShareFiles(): boolean {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
      && navigator.canShare({ files: [new File([], 'x.png', { type: 'image/png' })] })
  } catch {
    return false
  }
}

/** The row on the phone home. */
export function PhoneShareWeek() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" data-phone-share-week onClick={() => setOpen(true)}
        className="flex min-h-[52px] min-w-0 items-center gap-3 rounded-[12px] border border-border bg-panel px-3 py-2 text-left text-fg active:bg-panel-2">
        <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent/15 text-accent"><ShareGlyph size={14} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-medium leading-[1.3]">Share your week</span>
          <span className="block truncate text-[13px] text-fg-muted">Your week as a picture, to Threads, X or any app</span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-fg-faint"><ChevronIcon size={16} /></span>
      </button>
      {open && <PhoneShareSheet onClose={() => setOpen(false)} />}
    </>
  )
}

/** Two frames, so a card just given its figures has been laid out before it is captured. */
const settled = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

export function PhoneShareSheet({ onClose }: { onClose: () => void }) {
  const size = CARD_SIZE.port
  const words = periodWords('7d')
  const [look] = useState<CardLook>(rememberedLook)
  const [plan, setPlan] = useState<CardPlan | undefined>(undefined)
  const [week, setWeek] = useState<Week | undefined>(() => lastStory('7d')?.value)
  const [failed, setFailed] = useState(false)
  // The file, drawn from the current figures before the tap.
  const [file, setFile] = useState<File | undefined>(undefined)
  const [note, setNote] = useState('')
  const card = useRef<HTMLElement>(null)
  const native = canShareFiles()

  useEffect(() => {
    let live = true
    api.settings().then((s) => { if (live) setPlan(planOf(s)) }).catch(() => { /* dollars, then */ })
    currentStory('7d').then((w) => { if (live) setWeek(w) }).catch(() => { if (live && !lastStory('7d')) setFailed(true) })
    return () => { live = false }
  }, [])

  // Draw the PNG once the current figures (and the plan) are on the card.
  useEffect(() => {
    if (!week || week.sessions === 0) return
    let live = true
    setFile(undefined)
    void (async () => {
      try {
        await currentStory('7d')
        await settled()
        if (!live || !card.current) return
        const blob = await renderCardPNG(card.current, size)
        if (!live) return
        if (!blob) { setFailed(true); return }
        setFile(new File([blob], cardFilename().replace('caprock-', `caprock-7d-${size.w}x${size.h}-`), { type: 'image/png' }))
      } catch {
        if (live) setFailed(true)
      }
    })()
    return () => { live = false }
  }, [week, plan, look, size])

  // No await before navigator.share: the tap's permission to open the menu
  // does not survive one in Safari.
  const share = () => {
    if (!file) return
    setNote('')
    navigator.share({ files: [file] }).then(onClose, (e: unknown) => {
      if ((e as Error)?.name !== 'AbortError') setNote('Sharing was not available here — use Save image.')
    })
  }
  const save = () => {
    if (!file) return
    download(file, file.name)
    setNote('Saved to your downloads.')
  }

  const empty = !!week && week.sessions === 0
  const big = 'flex h-12 w-full items-center justify-center rounded-[12px] text-[16px] font-semibold disabled:opacity-50'
  return (
    <BottomSheet title="Share your week" onClose={onClose} footer={
      <div className="grid gap-2">
        {native && (
          <button type="button" data-phone-share-native onClick={share} disabled={!file} className={`${big} bg-accent text-bg`}>
            {file || empty || failed ? 'Share…' : 'Drawing…'}
          </button>
        )}
        {(!native || note.startsWith('Sharing')) && (
          <button type="button" onClick={save} disabled={!file} className={`${big} ${native ? 'border border-border-strong text-fg' : 'bg-accent text-bg'}`}>
            {file || empty || failed ? 'Save image' : 'Drawing…'}
          </button>
        )}
        {note && <p role="status" className="text-center text-[13px] text-fg-muted">{note}</p>}
      </div>
    }>
      <div className="pt-1">
        {week && !empty ? (
          <Scaled w={size.w} h={size.h} max={300}>
            <WeekCard ref={card} week={week} layout="port" when={words.when} noun={words.noun} look={look} plan={plan} />
          </Scaled>
        ) : (
          <div className="mx-auto flex max-w-[300px] items-center justify-center rounded-[12px] border border-border bg-panel-2 px-6 text-center text-[13px] text-fg-muted"
            style={{ aspectRatio: `${size.w} / ${size.h}` }}>
            {empty ? 'Nothing ran this week on this machine, so there is no card yet.'
              : failed ? 'Could not read the figures. Close and open this again to try.'
                : 'Drawing your card…'}
          </div>
        )}
        <p className="mt-3 text-center text-[13px] text-fg-muted">
          {native
            ? 'Opens your share menu with the picture — pick Threads, X or any app. Totals only, nothing uploaded.'
            : 'Saves the picture to post from any app. Totals only, nothing uploaded.'}
        </p>
      </div>
    </BottomSheet>
  )
}
