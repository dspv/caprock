/**
 * Installing the phone's page as an app, once and on purpose (ADR-058).
 *
 * The owner, 2026-10-14 (translated): "I opened it again and Caprock started
 * downloading again — very strange. Maybe m.caprock.dev should have an
 * install button?" On Android, "downloading" is Chrome minting a WebAPK. The
 * page left installing to Chrome's own prompts, which appear in any browser
 * tab of an installable page — and a pairing link scanned with the camera
 * opens in a browser tab — while its own words said "Share → Add to Home
 * Screen", iPhone wording, to everyone.
 *
 * Now:
 * - Chrome's automatic prompt is held back (`beforeinstallprompt` is
 *   prevented) and kept for the page's own **Install the Caprock app**
 *   button. Chrome fires that event only while the app is not installed, so
 *   the button never offers a second copy.
 * - The app records that it ran installed. On Android the app and Chrome
 *   share this origin's storage, so a browser tab can say "Caprock is on your
 *   home screen" instead of offering anything.
 * - On an iPhone, where Safari has no such event, the page says how.
 * - The manifest's `id` stays "/" — a new build of the page is the same app,
 *   and changing the id would install a second one.
 */
import { useEffect, useState } from 'react'

/** Whether this page runs as the home-screen app (lib/phonehome's, kept here so main.tsx stays small). */
function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch { /* an old browser */ }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export const INSTALLED_KEY = 'caprock.remote.installed'

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function setInstalled(on: boolean) {
  try {
    if (on) localStorage.setItem(INSTALLED_KEY, '1')
    else localStorage.removeItem(INSTALLED_KEY)
  } catch { /* private mode: the page offers again */ }
}

function installedFlag(): boolean {
  try {
    return localStorage.getItem(INSTALLED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Called once, before anything renders: Chrome may fire
 * `beforeinstallprompt` before the page's own code has loaded.
 */
export function listenForInstall(w: Window = window) {
  w.addEventListener('beforeinstallprompt', (e) => {
    // Chrome offers an install only while this app is not installed, so a
    // remembered "installed" is stale: it was removed from the home screen.
    e.preventDefault()
    deferred = e as InstallPromptEvent
    setInstalled(false)
    notify()
  })
  w.addEventListener('appinstalled', () => {
    deferred = null
    setInstalled(true)
    notify()
  })
  if (isStandalone()) setInstalled(true)
}

/** What to offer about installing, if anything. */
export type InstallOffer = 'button' | 'installed' | 'ios' | null

/**
 * Pure, for the tests: the app itself offers nothing; a browser Chrome says
 * can install gets the button; a browser on a phone where the app ran gets
 * "it is on your home screen"; Safari on an iPhone gets the steps. Anything
 * else — Android without Chrome's go-ahead, a desktop — gets nothing, rather
 * than menu steps that could add a second icon.
 */
export function installOffer(o: { standalone: boolean; prompt: boolean; installed: boolean; ua: string; touchPoints: number }): InstallOffer {
  if (o.standalone) return null
  if (o.prompt) return 'button'
  if (o.installed) return 'installed'
  if (/iPhone|iPad|iPod/.test(o.ua) || (/Macintosh/.test(o.ua) && o.touchPoints > 1)) return 'ios'
  return null
}

/** Which phone this is, for the words of a home-screen step: an iPhone or iPad, an Android phone, or neither. */
export function phoneKind(ua: string, touchPoints: number): 'ios' | 'android' | null {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  return null
}

function current(): InstallOffer {
  return installOffer({
    standalone: isStandalone(),
    prompt: deferred !== null,
    installed: installedFlag(),
    ua: navigator.userAgent,
    touchPoints: navigator.maxTouchPoints ?? 0,
  })
}

/** The offer, kept current as Chrome's events arrive. */
export function useInstallOffer(): InstallOffer {
  const [offer, setOffer] = useState<InstallOffer>(current)
  useEffect(() => {
    const fn = () => setOffer(current())
    listeners.add(fn)
    fn()
    return () => {
      listeners.delete(fn)
    }
  }, [])
  return offer
}

/** Shows Chrome's install dialog; true when the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred
  if (!e) return false
  // A prompt can be shown once; Chrome fires the event again if it may be
  // offered again.
  deferred = null
  notify()
  await e.prompt()
  const { outcome } = await e.userChoice
  if (outcome === 'accepted') setInstalled(true)
  notify()
  return outcome === 'accepted'
}
