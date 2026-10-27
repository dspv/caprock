/**
 * A pairing link, from the camera or pasted, handed to the phone's page as
 * if it had been opened with it: remote/boot.ts's prepare() reads it on the
 * reload, stores the machine and sends the code to the pairing screen.
 * Pure but for the navigation, so the tests can read it.
 */
import { parsePairLink } from '@/remote/boot'

/** The `#/pair?…` part of whatever the code or the paste held, or '' when it is not a Caprock pairing link. */
export function pairHash(raw: string): string {
  const t = raw.trim()
  const hash = t.includes('#') ? t.slice(t.indexOf('#')) : ''
  return hash && parsePairLink(hash) ? hash : ''
}

export const NOT_A_LINK = 'That is not a Caprock pairing link. On your computer: Caprock → Settings → Use on your phone → Connect a phone, then scan its code or tap Copy link.'

/** Opens the link in this page; false (and nothing happens) when it is not one. */
export function openPairLink(raw: string, loc: Location = window.location): boolean {
  const hash = pairHash(raw)
  if (!hash) return false
  loc.replace(loc.pathname + hash)
  loc.reload()
  return true
}
