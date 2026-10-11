/**
 * "Take Caprock with you" — phone access and the Telegram bot, as a checklist.
 *
 * Owner, 2026-10-10 (translated): a banner for connecting the phone or
 * Telegram that tracks the status, can be marked done, and stops appearing
 * once the integration is in place. So each item ticks itself from the
 * daemon (a paired phone, a bot with a paired chat) rather than from a
 * click, "Not needed" retires one item for good, and × on the strip puts it
 * away for a week (lib/prompts.ts). It holds the one nudge slot like every
 * other offer (lib/nudges.ts) and sits where the star strip does, never over
 * a terminal.
 */
import { api, isPairedDevice } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { markAnswered, usePromptDue } from '@/lib/prompts'
import { useNudgeSlot } from '@/lib/nudges'
import { openPhoneSettings, openSettingsAt } from './Pairing'
import { Banner, BannerButton, BannerDismiss } from './Banner'

interface Item {
  key: 'phone' | 'telegram'
  label: string
  done: boolean
  skipped: boolean
  action: string
  open: () => void
  skip: () => void
}

/** `app`: kept for the callers; the strip draws the same in the app and the dashboard. */
export function SetupStrip({ now = Date.now() }: { now?: number; app?: boolean }) {
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
      done: (pair.data?.devices?.length ?? 0) > 0,
      skipped: phoneSkipped,
      action: 'Open on your phone',
      open: openPhoneSettings,
      skip: () => markAnswered('setup-phone-skip', now),
    },
    {
      key: 'telegram',
      label: 'Telegram',
      done: !!tg.data?.bot_set && !!tg.data?.chat_set,
      skipped: tgSkipped,
      action: 'Connect Telegram',
      open: () => openSettingsAt('telegram'),
      skip: () => markAnswered('setup-telegram-skip', now),
    },
  ]
  const loaded = !!pair.data && !!tg.data
  const open = items.filter((i) => !i.done && !i.skipped)
  const eligible = machine && loaded && !later && open.length > 0
  const mine = useNudgeSlot('setup', eligible)
  if (!mine) return null

  const shown = items.filter((i) => !i.skipped)
  const doneCount = shown.filter((i) => i.done).length
  const first = shown.find((i) => !i.done)
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
        {shown.map((i) =>
          i.done ? (
            <span key={i.key} data-setup={i.key} className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-muted">
              <span aria-hidden className="text-ok">✓</span> {i.label} connected
            </span>
          ) : (
            <span key={i.key} data-setup={i.key} className="inline-flex items-center gap-2">
              {/* One filled button: the first open item. A second is the
                * outlined kind, so the strip still has one primary. */}
              <BannerButton kind={i === first ? 'accent' : 'ghost'} onClick={i.open}>{i.action}</BannerButton>
              <button type="button" onClick={i.skip} title={`Never ask about ${i.label} again`} className="bn-link">
                Not needed
              </button>
            </span>
          ),
        )}
        <BannerDismiss icon onClick={() => markAnswered('setup-later', now)} aria-label="Hide for a week" title="Hide for a week" />
      </>}
    />
  )
}
