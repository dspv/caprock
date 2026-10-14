/**
 * The offer survey's card (lib/offer.ts, ADR-062): one question about a
 * feature Caprock may build.
 *
 * Drawn by the banner system in its edge form, like the Mail and star
 * strips: in the page's flow above the status strip, so it never covers a
 * terminal or a permission prompt. It waits for the keyboard to be still,
 * stays away while a session waits on a permission prompt (`busy`), holds
 * the single offer slot (lib/nudges.ts) and never shows on a paired phone,
 * which may not send it. Which offer, and whether today, is lib/offer.ts.
 *
 * A survey card is the headline, one line, two one-click questions and an
 * optional email. Send is the only thing that sends anything, and the line
 * under it says what and where. "Not interested" and × send nothing; every
 * answer is final.
 */
import { useEffect, useState } from 'react'
import { api, errText, isPairedDevice } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { usePromptStore } from '@/lib/prompts'
import { useNudgeSlot } from '@/lib/nudges'
import {
  forcedOffer, markOfferAnswered, markShown, offerForToday, OFFER_QUIET_MS,
  useKeyboardQuiet, type Offer, type OfferQuestion,
} from '@/lib/offer'
import { Banner, BannerButton, BannerDismiss } from './Banner'
import './OfferStrip.css'

/** What Send discloses, word for word (owner, 2026-10-14). */
export const OFFER_DISCLOSURE = "Sends these answers, and your email if you add one, to caprock.dev. Nothing else."
export const OFFER_THANKS = 'Thanks — that helps us decide.'
const EMAIL_LABEL = "Email, if you want to hear when it's ready (optional)"

export function OfferStrip({ now = Date.now(), busy = false, quietMs = OFFER_QUIET_MS }: {
  now?: number
  /** A session is waiting on a permission prompt: do not appear now. */
  busy?: boolean
  quietMs?: number
}) {
  const forced = forcedOffer()
  const hist = useApi(() => api.history('all'), [], { live: false, intervalMs: 600_000, share: 'history:all' })
  usePromptStore() // re-render when any mark changes, here or from the daemon
  const quiet = useKeyboardQuiet(forced ? 0 : quietMs)
  const [sent, setSent] = useState(false)
  // The offer on screen, held once shown so an answer given in the card
  // does not swap it for another one mid-sentence.
  const [held, setHeld] = useState<Offer | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const today = !isPairedDevice() && quiet && !busy ? offerForToday(hist.data?.totals, now) : null
  const offer = forced ?? held ?? today
  const mine = useNudgeSlot('offer', !!offer)

  useEffect(() => {
    if (!mine || !offer || held) return
    setHeld(offer)
    // A forced card is a preview: it records nothing, so it can be shown again.
    if (!forced) markShown(offer, now)
  }, [mine, offer, held, forced, now])

  useEffect(() => {
    if (!sent) return
    const t = setTimeout(() => { setSent(false); setHeld(null); setAnswers({}); setEmail('') }, 4000)
    return () => clearTimeout(t)
  }, [sent])

  if (!mine || !offer) return null
  const close = () => { if (!forced) markOfferAnswered(offer, 'no', now); setHeld(null); setAnswers({}) }

  // An offer that can be tried already opens it: no answer, nothing sent.
  const tryIt = offer.tryHref
    ? <BannerButton kind="ghost" data-offer-try onClick={() => { location.hash = offer.tryHref! }}>Try it now</BannerButton>
    : null

  if (sent) {
    return <Banner id="offer" edge art="done" role="region" label="Question from Caprock" title={<span role="status">{OFFER_THANKS}</span>} actions={tryIt} />
  }

  const send = async () => {
    setSending(true)
    setError('')
    try {
      const e = email.trim()
      await api.sendOffer({ offer: offer.id, answers, ...(e ? { email: e } : {}) })
      if (!forced) markOfferAnswered(offer, 'sent', now)
      setSent(true)
    } catch (err) {
      setError(errText(err) || 'Could not send. Nothing was saved; try again.')
    } finally {
      setSending(false)
    }
  }

  const emailOk = email.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const ready = offer.questions.every((q) => !!answers[q.key]) && emailOk && !sending
  return (
    <Banner
      id="offer"
      edge
      art="ask"
      role="region"
      label="Question from Caprock"
      className="of-banner"
      title={offer.title}
      line={
        <>
          <span className="of-lede">{offer.line}</span>
          <form className="of-form" onSubmit={(e) => { e.preventDefault(); if (ready) void send() }}>
            {offer.questions.map((q) => (
              <Choice key={q.key} q={q} value={answers[q.key] ?? ''} onChange={(v) => setAnswers((a) => ({ ...a, [q.key]: v }))} />
            ))}
            <label className="of-row">
              <span className="of-q">{EMAIL_LABEL}</span>
              <input
                type="email"
                className="of-email"
                value={email}
                maxLength={254}
                autoComplete="email"
                aria-invalid={!emailOk || undefined}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {error && <p className="of-error" role="alert">{error}</p>}
          </form>
        </>
      }
      foot={<span className="of-disclose">{OFFER_DISCLOSURE}</span>}
      actions={<>
        <BannerButton disabled={!ready} onClick={() => void send()}>{sending ? 'Sending…' : 'Send'}</BannerButton>
        {tryIt}
        <BannerDismiss onClick={close}>Not interested</BannerDismiss>
        <BannerDismiss icon onClick={close} aria-label="Close, not interested" title="Not interested" />
      </>}
    />
  )
}

function Choice({ q, value, onChange }: { q: OfferQuestion; value: string; onChange: (v: string) => void }) {
  return (
    <div className="of-row" role="group" aria-label={q.label}>
      <span className="of-q">{q.label}</span>
      <span className="of-opts">
        {q.options.map((o) => (
          <button key={o.value} type="button" className="of-opt" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </span>
    </div>
  )
}
