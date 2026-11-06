/**
 * Links iOS opens the app with (ADR-083). The computer's pairing QR holds
 * https://m.caprock.dev/#/pair?…; m.caprock.dev's apple-app-site-association
 * (ui/public-remote/.well-known/) hands that link, and only that one, to the
 * app, so the iPhone's own Camera app opens Caprock instead of Safari.
 * @capacitor/app reports it as appUrlOpen while the app runs and as the
 * launch URL when it started the app; both go to pairing.ts's
 * openOpenedLink, which opens each link once. Nothing is sent anywhere: the
 * link is read on the phone, as a scanned one is.
 */
import { App } from '@capacitor/app'
import { openOpenedLink } from './pairing'

/** Starts listening; the returned function stops. */
export async function listenForOpenedLinks(open: (url: string) => unknown = openOpenedLink): Promise<() => void> {
  const handle = await App.addListener('appUrlOpen', (e) => { open(e.url) })
  try {
    const launch = await App.getLaunchUrl()
    if (launch?.url) open(launch.url)
  } catch { /* no launch link */ }
  return () => { void handle.remove() }
}
