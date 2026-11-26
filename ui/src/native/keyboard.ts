/**
 * The iOS app's keyboard (ADR-083, .ai/04-ui.md § The iOS app, *Safe areas
 * and the keyboard*), through @capacitor/keyboard. Reached only by dynamic
 * import behind isNativeApp() (lib/keyboard.ts, NativeRoot), so the web page
 * and the desktop never load it.
 *
 * The plugin hides WKWebView's accessory bar (‹ › Done over the keyboard) the
 * moment it loads, and no setting in capacitor.config.json brings it back; the
 * app asks for it at start, so Done is there to put the keyboard away, as in
 * Safari.
 */
import { Keyboard } from '@capacitor/keyboard'

/** Puts the keyboard away, whatever has the focus. */
export async function hideNativeKeyboard(): Promise<void> {
  await Keyboard.hide()
}

/** The bar with Done over the keyboard, as Safari shows it. */
export async function showAccessoryBar(): Promise<void> {
  await Keyboard.setAccessoryBarVisible({ isVisible: true })
}
