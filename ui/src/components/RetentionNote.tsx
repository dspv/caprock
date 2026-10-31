/**
 * One quiet line under the Lifetime screen's daily chart: Claude Code
 * deletes transcripts older than `cleanupPeriodDays` (30 unless set), and
 * Caprock can only import what is still on disk, so a new user's history
 * starts about that far back (a user asked why his began on 20 September
 * when he wanted a year, 2026-10-24). The button writes the setting into
 * ~/.claude/settings.json — the one key, through the daemon, on this
 * machine; nothing is sent anywhere (POST /v1/claude/retention).
 *
 * Shown while the period is unset or 90 days or fewer (`offer`); a longer
 * one is the user's own choice and gets no line. After the write it says
 * "Kept from now on" for a few seconds and goes.
 */
import { useEffect, useState } from 'react'
import { api, ApiError, isPairedDevice } from '@/lib/api'
import { useApi } from '@/lib/useApi'

/** How long "Kept from now on" stays before the line goes. */
export const KEPT_SHOWN_MS = 6000

/** "20 Sep" this year, "20 Sep 2025" another; undefined for no day. */
export function shortDay(day: string | undefined, now = new Date()): string | undefined {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const date = new Date(y, m - 1, d)
  const opts: Intl.DateTimeFormatOptions = y === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }
  return date.toLocaleDateString('en-GB', opts)
}

/** The sentence, without the button. */
export function retentionLine(days: number, earliest: string | undefined, now = new Date()): string {
  const span = days === 1 ? '1 day' : `${days} days`
  const from = shortDay(earliest, now)
  return from
    ? `Claude Code deletes conversations older than ${span}, so the history before ${from} was gone before Caprock saw it.`
    : `Claude Code deletes conversations older than ${span}, so older history was gone before Caprock saw it.`
}

export function RetentionNote({ earliest }: {
  /** The first day Caprock holds anything for ('YYYY-MM-DD'). */
  earliest?: string
}) {
  // The machine's own settings: a paired device neither reads nor writes them.
  const paired = isPairedDevice()
  const r = useApi(() => (paired ? Promise.resolve(undefined) : api.retention()), [paired], { live: false })
  const [state, setState] = useState<'idle' | 'busy' | 'kept' | 'gone'>('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    if (state !== 'kept') return
    const t = window.setTimeout(() => setState('gone'), KEPT_SHOWN_MS)
    return () => window.clearTimeout(t)
  }, [state])

  if (paired || state === 'gone') return null
  if (state === 'kept') {
    return <p data-retention="kept" role="status" className="px-3 pb-2.5 text-[12px] text-fg-muted">Kept from now on.</p>
  }
  const data = r.data
  if (!data || !data.offer) return null

  async function keep() {
    setState('busy')
    setError('')
    try {
      await api.keepTranscripts()
      setState('kept')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      setState('idle')
    }
  }

  return (
    <div data-retention="offer" className="px-3 pb-2.5 text-[12px] leading-snug text-fg-faint">
      <span>{retentionLine(data.days, earliest)}</span>{' '}
      <button
        type="button"
        data-retention-keep
        // A setting, not a figure: left out of a shared picture.
        data-share-skip
        onClick={keep}
        disabled={state === 'busy'}
        title={`Sets cleanupPeriodDays to ${data.keep_days} in ~/.claude/settings.json, keeping every other setting as it is`}
        className="text-fg-muted underline underline-offset-2 hover:text-fg disabled:opacity-50"
      >
        {state === 'busy' ? 'Saving…' : 'Keep them from now on'}
      </button>
      {error && <p role="alert" className="mt-1 text-danger">Nothing was changed: {error}</p>}
    </div>
  )
}
