/**
 * Why the phone's page cannot reach its computer, as one of four causes a
 * person can tell apart and act on (owner, 2026-10-21, translated: "When the
 * phone loses network while Caprock is open, I see 'Retry' and 'Pair again'.
 * The connection is just bad sometimes … Pair again is a pain").
 *
 * - `offline`: this phone has no network — the browser says so, or nothing
 *   at all answers (not the relay, not the page's own address).
 * - `relay`: the phone has a network but the relay does not answer: a VPN
 *   or a network that blocks it.
 * - `computer`: the relay answers and the computer does not — asleep, off
 *   the internet, Caprock not running, or restarting.
 * - `reconnecting`: an open channel dropped, cause not known yet.
 * - `unpaired`: the computer said so, on separate connections — it removed
 *   this phone, or its keys are not the ones the phone paired with. The only
 *   cause that offers **Pair again**; a timeout or a network error never is.
 *
 * Offline wins over unpaired: pairing needs the network too, and the screen
 * says the thing that is wrong now.
 */
import { needsPairing, type Problem } from './transport'

export type Cause = 'offline' | 'relay' | 'computer' | 'reconnecting' | 'unpaired'

export function classify(problem: Problem, online: boolean): Cause {
  if (!online || problem === 'no-internet') return 'offline'
  if (needsPairing(problem)) return 'unpaired'
  switch (problem) {
    case 'relay-unreachable':
      return 'relay'
    case 'machine-offline':
    case 'no-answer':
      return 'computer'
    default:
      return 'reconnecting'
  }
}

/** Whether a cause offers Pair again: only a pairing the computer refused. */
export function offersPairing(cause: Cause): boolean {
  return cause === 'unpaired'
}

/** "40 s ago", "2 min ago", "3 h ago": how old the dimmed screen is. */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${Math.max(1, s)}\u00a0s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}\u00a0min ago`
  return `${Math.floor(m / 60)}\u00a0h ago`
}

/**
 * The live line under the headline: the try under way, or the next one and
 * its number. Never empty, so the page is never silent.
 */
export function retryLine(connecting: boolean, nextAt: number | null, attempt: number, now: number): string {
  if (connecting || nextAt === null) return 'Trying now…'
  const s = Math.max(1, Math.ceil((nextAt - now) / 1000))
  return `Next try in ${s} s · attempt ${attempt + 1}`
}
