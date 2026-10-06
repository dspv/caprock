import { isSilent, type LinkStatus } from '@/lib/reconnect'
import { useNow } from '@/lib/useNow'

type Tone = 'ok' | 'warn' | 'danger' | 'muted'

interface Reading {
  tone: Tone
  label: string
  title: string
}

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  muted: 'bg-fg-faint',
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function retryIn(nextAt: number | null, now: number): string {
  if (nextAt === null) return 'trying now'
  return `next try in ${Math.max(1, Math.ceil((nextAt - now) / 1000))} s`
}

function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * What the connection is, in words that are never more hopeful than the
 * facts: "Live" only with a round trip inside DEAD_MS, whatever the socket's
 * own state says — a socket the network silently dropped still reads as open.
 */
function readLink(link: LinkStatus, heardAt: number, now: number): Reading {
  switch (link.phase) {
    case 'revoked':
      return { tone: 'danger', label: `Control revoked — ${link.reason ?? 'this device can no longer control sessions'}`, title: 'Reconnecting would be refused, so it is not tried.' }
    case 'ended':
      return { tone: 'muted', label: 'Session ended', title: 'The session’s program exited.' }
    case 'live':
      if (!isSilent(heardAt, now)) {
        return { tone: 'ok', label: 'Live', title: `Last heard from the daemon ${Math.max(0, Math.round((now - heardAt) / 1000))} s ago.` }
      }
      return { tone: 'warn', label: 'Not answering — reconnecting', title: 'Nothing from the daemon in 25 s; the connection is being replaced.' }
    case 'catching-up':
      return { tone: 'warn', label: 'Catching up…', title: 'Connected; fetching what was missed.' }
    case 'connecting':
      return { tone: 'warn', label: 'Connecting…', title: 'Opening the connection to the daemon.' }
    case 'reconnecting': {
      const since = link.downSince ?? now
      if (isBrowserOffline()) {
        return { tone: 'danger', label: `Offline since ${clock(since)}`, title: `No network. Retrying by itself — ${retryIn(link.nextAt, now)}.` }
      }
      return {
        tone: 'warn',
        // The number of the try under way, or of the next one.
        label: `Reconnecting (${link.nextAt === null ? link.attempt : link.attempt + 1}) · ${retryIn(link.nextAt, now)}`,
        title: `Lost at ${clock(since)}. Retrying by itself, no tap needed.`,
      }
    }
  }
}

/**
 * The honest connection indicator (.ai/21-app.md § Phone v2): live, catching
 * up, reconnecting with the attempt and the next try, offline since when, or
 * revoked with the reason. Re-read every second, because the facts it reports
 * change with time when nothing arrives.
 */
export function ConnectionState({ link, heardAt, className = '' }: { link: LinkStatus; heardAt: () => number; className?: string }) {
  // Live, only the tooltip's "heard N s ago" moves: a slower clock (WP-16,
  // CPU of an idle window); every other phase counts down by the second.
  const now = useNow(link.phase === 'live' ? 5000 : 1000)
  const reading = readLink(link, heardAt(), now)
  return (
    <span role="status" aria-live="polite" title={reading.title} data-link={link.phase} className={`inline-flex items-center gap-1.5 ${className}`}>
      <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[reading.tone]}`} />
      <span className="num">{reading.label}</span>
    </span>
  )
}
