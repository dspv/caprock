/**
 * "A star on GitHub helps others find it." — the one favour Caprock asks.
 *
 * A strip at the bottom of the dashboard and above the app's status strip,
 * never over content, drawn by the banner system (Banner.tsx) in its edge
 * form. It appears only after real use (lib/nudges.ts starEligible: three
 * days with sessions, ten sessions), never on a first run, and only when no
 * other offer holds the slot. "I starred it" thanks the reader once and never
 * asks again; × puts it away for a month. Both answers are kept on the
 * daemon, so the app and a browser tab agree.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { markAnswered, usePromptDue } from '@/lib/prompts'
import { openExternal, REPO_URL, starEligible, useNudgeSlot } from '@/lib/nudges'
import { Banner, BannerButton, BannerDismiss } from './Banner'
import { extTitle } from '@/lib/externalLinks'

/** `app`: kept for the callers; the strip draws the same in the app and the dashboard. */
export function StarStrip({ now = Date.now() }: { now?: number; app?: boolean }) {
  const hist = useApi(() => api.history('all'), [], { live: false, intervalMs: 600_000, share: 'history:all' })
  const done = !usePromptDue('star-done', now)
  const snoozed = !usePromptDue('star-dismissed', now)
  const [thanks, setThanks] = useState(false)
  const eligible = thanks || (!done && !snoozed && starEligible(hist.data?.totals))
  const mine = useNudgeSlot('star', eligible)

  useEffect(() => {
    if (!thanks) return
    const t = setTimeout(() => setThanks(false), 3000)
    return () => clearTimeout(t)
  }, [thanks])

  if (!mine) return null
  if (thanks) {
    return <Banner id="star" edge art="star" role="region" label="Star Caprock on GitHub" title={<span role="status">Thank you!</span>} line="It helps others find Caprock." />
  }
  return (
    <Banner
      id="star"
      edge
      art="star"
      role="region"
      label="Star Caprock on GitHub"
      title="Enjoying Caprock?"
      line="A star on GitHub helps others find it."
      actions={<>
        <BannerButton onClick={() => openExternal(REPO_URL)} title={extTitle()}><span aria-hidden>★</span> Star on GitHub ↗</BannerButton>
        <button type="button" onClick={() => { markAnswered('star-done', now); setThanks(true) }} className="bn-link">I starred it</button>
        <BannerDismiss icon onClick={() => markAnswered('star-dismissed', now)} aria-label="Hide for a month" title="Hide for a month" />
      </>}
    />
  )
}
