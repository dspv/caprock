/**
 * A pairing link, from the camera, pasted, or the link iOS opened the app
 * with (the computer's QR read by the iPhone's own Camera app), handed to the
 * phone's page as if it had been opened with it: remote/boot.ts's prepare()
 * reads it on the reload, stores the machine and sends the code to the
 * pairing screen. Pure but for the navigation, so the tests can read it.
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

/** The demo's flag (sessionStorage): the demo lasts until it is left or the app is closed. */
export const DEMO_KEY = 'caprock.ios.demo'
/** The last link the app was opened with (sessionStorage), so a reload does not open it again. */
export const OPENED_KEY = 'caprock.ios.opened'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function session(): Store | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/**
 * A link iOS opened the app with: the pairing QR scanned by the iPhone's
 * Camera app opens https://m.caprock.dev/#/pair?… here as a universal link
 * (ADR-083). It goes through openPairLink, the path the in-app scanner's code
 * takes, so the two behave the same. Each link opens once: iOS keeps the
 * launch link for the life of the app, and openPairLink reloads the page. A
 * link opened during the demo leaves it, as pairing does. False when the
 * link is not a pairing link or was opened already.
 */
export function openOpenedLink(url: string, loc: Location = window.location, store: Store | null = session()): boolean {
  if (!pairHash(url)) return false
  try {
    if (store?.getItem(OPENED_KEY) === url) return false
    store?.setItem(OPENED_KEY, url)
    store?.removeItem(DEMO_KEY)
  } catch { /* storage refused: open it anyway */ }
  return openPairLink(url, loc)
}
