/**
 * "Take Caprock with you" — phone access and the Telegram bot, as a checklist.
 *
 * Owner, 2026-10-10 (translated): a banner for connecting the phone or
 * Telegram that tracks the status, can be marked done, and stops appearing
 * once the integration is in place. So each item ticks itself from the
 * daemon (a paired phone, a bot with a paired chat) rather than from a
 * click. It holds the one nudge slot like every other offer (lib/nudges.ts)
 * and sits where the star strip does, never over a terminal.
 *
 * Owner, 2026-10-15: five buttons on one strip were too many. The strip now
 * has two — **Set up**, which opens a small list of the two items, each with
 * its state, its own action and *Not needed*, and **Later**, which puts the
 * strip away for three days. × does not dismiss: it folds the strip to a
 * "0 of 2" chip in the status bar (SetupChip), and the chip opens it again.
 * Folded, it keeps the nudge slot, so folding it never brings another banner
 * up in its place. All of it lives in lib/prompts.ts with the other answers.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, isPairedDevice } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { markAnswered, promptAt, usePromptDue, usePromptStore } from '@/lib/prompts'
import { useNudgeSlot } from '@/lib/nudges'
import { openPhoneSettings, openSettingsAt } from './Pairing'
import { Banner, BannerButton, BannerDismiss } from './Banner'

interface Item {
  key: 'phone' | 'telegram'
  label: string
  /** What it gives you, in a few words: the popover's second line. */
  what: string
  done: boolean
  skipped: boolean
  action: string
  open: () => void
  skip: () => void
}

/** Whether × has folded the strip to its chip: the later of the two marks wins. */
export function useSetupFolded(): boolean {
  usePromptStore()
  return (promptAt('setup-collapsed') ?? 0) > (promptAt('setup-expanded') ?? 0)
}

/**
 * What the strip last worked out, for the chip: the strip is the one that
 * asks the daemon, so the folded chip adds no requests of its own.
 */
interface Snap { eligible: boolean; done: number; total: number }
let snap: Snap = { eligible: false, done: 0, total: 0 }
const listeners = new Set<() => void>()
function publish(next: Snap) {
  if (next.eligible === snap.eligible && next.done === snap.done && next.total === snap.total) return
  snap = next
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** For tests: forget what the strip published. */
export function resetSetupChip() {
  snap = { eligible: false, done: 0, total: 0 }
}

/** The checklist and whether it has anything to say. */
function useSetup(now: number) {
  const machine = !isPairedDevice()
  const pair = useApi(() => (machine ? api.pairState() : Promise.resolve(null)), [machine], { live: false, intervalMs: 30_000 })
  const tg = useApi(() => (machine ? api.telegram() : Promise.resolve(null)), [machine], { live: false, intervalMs: 30_000 })
  const later = !usePromptDue('setup-later', now)
  const phoneSkipped = !usePromptDue('setup-phone-skip', now)
  const tgSkipped = !usePromptDue('setup-telegram-skip', now)

  const items: Item[] = [
    {
      key: 'phone',
      label: 'Phone',
      what: 'Open sessions and answer them from your phone',
      done: (pair.data?.devices?.length ?? 0) > 0,
      skipped: phoneSkipped,
      action: 'Open on your phone',
      open: openPhoneSettings,
      skip: () => markAnswered('setup-phone-skip', now),
    },
    {
      key: 'telegram',
      label: 'Telegram',
      what: 'Alerts and replies through your own bot',
      done: !!tg.data?.bot_set && !!tg.data?.chat_set,
      skipped: tgSkipped,
      action: 'Connect Telegram',
      open: () => openSettingsAt('telegram'),
      skip: () => markAnswered('setup-telegram-skip', now),
    },
  ]
  const loaded = !!pair.data && !!tg.data
  const open = items.filter((i) => !i.done && !i.skipped)
  const shown = items.filter((i) => !i.skipped)
  return {
    shown,
    doneCount: shown.filter((i) => i.done).length,
    eligible: machine && loaded && !later && open.length > 0,
  }
}

/** `app`: kept for the callers; the strip draws the same in the app and the dashboard. */
export function SetupStrip({ now = Date.now() }: { now?: number; app?: boolean }) {
  const folded = useSetupFolded()
  const { shown, doneCount, eligible } = useSetup(now)
  useEffect(() => { publish({ eligible, done: doneCount, total: shown.length }) }, [eligible, doneCount, shown.length])
  // Folded, it still holds the slot: × makes it small, it does not answer it.
  const holding = useNudgeSlot('setup', eligible)
  const [list, setList] = useState(false)
  if (!holding || folded) return null

  return (
    <Banner
      id="setup"
      edge
      art="phone"
      role="region"
      label="Take Caprock with you"
      title={<>Take Caprock with you{shown.length > 1 && <small className="num">{doneCount} of {shown.length}</small>}</>}
      line="Answer your agents away from the desk."
      actions={<>
        <span className="relative inline-flex">
          <BannerButton kind="accent" aria-haspopup="dialog" aria-expanded={list} onClick={() => setList((v) => !v)} data-setup-open>
            Set up
          </BannerButton>
          {list && <SetupList items={shown} onClose={() => setList(false)} />}
        </span>
        <button type="button" className="bn-link" onClick={() => markAnswered('setup-later', now)} title="Hide this for three days">
          Later
        </button>
        <BannerDismiss icon onClick={() => markAnswered('setup-collapsed', now)} aria-label="Fold to the status bar" title="Fold to the status bar" />
      </>}
    />
  )
}

/** The popover: one row per item, its state, its action, and Not needed. */
function SetupList({ items, onClose }: { items: Item[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      // The Set up button toggles it itself.
      if (box.current?.contains(t) || (t as Element).closest?.('[data-setup-open]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])
  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Set up Caprock away from the desk"
      data-setup-list
      className="absolute bottom-[calc(100%+8px)] right-0 z-40 w-[320px] max-w-[calc(100vw-24px)] rounded-[10px] border border-border-strong bg-panel p-1.5 text-left shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]"
    >
      {items.map((i) => (
        <div key={i.key} data-setup={i.key} className="flex items-start gap-2.5 rounded-[7px] px-2.5 py-2">
          <span
            aria-hidden
            className={`mt-[3px] grid h-[16px] w-[16px] shrink-0 place-items-center rounded-full text-[10px] font-bold ${
              i.done ? 'bg-ok text-bg' : 'border border-border-strong'
            }`}
          >
            {i.done ? '✓' : ''}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold text-fg">{i.label}</span>
            <span className="block text-[11.5px] leading-snug text-fg-muted">{i.done ? `${i.label} connected` : i.what}</span>
            {!i.done && (
              <span className="mt-1.5 flex items-center gap-3">
                <button type="button" onClick={() => { onClose(); i.open() }}
                  className="inline-flex h-[26px] items-center rounded-[6px] bg-accent px-2.5 text-[12px] font-semibold text-bg hover:brightness-110">
                  {i.action}
                </button>
                <button type="button" onClick={i.skip} title={`Never ask about ${i.label} again`}
                  className="text-[11.5px] text-fg-faint hover:text-fg-muted hover:underline underline-offset-2">
                  Not needed
                </button>
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * The folded strip: "0 of 2" in the status bar (the app's StatusStrip, the
 * dashboard's footer). A click opens the strip again. Nothing while the
 * strip is unfolded, snoozed or has nothing left to offer.
 */
export function SetupChip() {
  const folded = useSetupFolded()
  const { eligible, done, total } = useSyncExternalStore(subscribe, () => snap)
  if (!folded || !eligible) return null
  return (
    <button
      type="button"
      data-setup-chip
      onClick={() => markAnswered('setup-expanded', Date.now())}
      title="Take Caprock with you: phone and Telegram. Click to show"
      className="inline-flex h-[18px] items-center gap-1.5 rounded-full border border-[var(--app-hairline-strong,var(--color-border-strong))] px-2 text-[11px] text-fg-muted hover:border-accent/60 hover:text-fg"
    >
      <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-accent" />
      <span className="num">{done} of {total}</span>
    </button>
  )
}
