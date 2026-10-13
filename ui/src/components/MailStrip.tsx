/**
 * "New: Caprock Mail" — the one-time offer to try Mail.
 *
 * Drawn by the banner system in its edge form, like the star strip, and only
 * when it holds the single offer slot (lib/nudges.ts). It appears after real
 * use (mailEligible: two days with sessions) and only while no mail account
 * exists. "Open Mail" goes to #/mail and answers it for good; × is "not now"
 * for a month. Answers live on the daemon, so the app and a browser tab agree.
 */
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { markAnswered, usePromptDue } from '@/lib/prompts'
import { mailEligible, useNudgeSlot } from '@/lib/nudges'
import { mailApi } from '@/screens/mail/mailApi'
import { Banner, BannerButton, BannerDismiss } from './Banner'

export function MailStrip({ now = Date.now() }: { now?: number }) {
  const hist = useApi(() => api.history('all'), [], { live: false, intervalMs: 600_000, share: 'history:all' })
  const mail = useApi(() => mailApi.state(), [], { live: false, intervalMs: 600_000, share: 'mail:state' })
  const done = !usePromptDue('mail-done', now)
  const later = !usePromptDue('mail-later', now)
  // An older daemon, or a test's mock, answers without accounts: no offer,
  // and never a broken screen.
  const accounts = Array.isArray(mail.data?.accounts) ? mail.data.accounts.length : undefined
  const eligible = !done && !later && location.hash !== '#/mail' && mailEligible(hist.data?.totals, accounts)
  const mine = useNudgeSlot('mail', eligible)
  if (!mine) return null
  return (
    <Banner
      id="mail"
      edge
      art="done"
      role="region"
      label="Caprock Mail"
      title="New: Caprock Mail"
      line="All your inboxes in one place, searchable in an instant, kept on this computer."
      actions={<>
        <BannerButton onClick={() => { markAnswered('mail-done', now); location.hash = '#/mail' }}>Open Mail</BannerButton>
        <BannerDismiss icon onClick={() => markAnswered('mail-later', now)} aria-label="Not now" title="Not now" />
      </>}
    />
  )
}
