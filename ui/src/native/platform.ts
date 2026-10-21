/**
 * Whether this page runs inside Caprock's iOS app (ADR-083), and the few
 * answers that follow from it.
 *
 * The app is the phone's page (`vite build --mode remote`) bundled into a
 * Capacitor shell. Capacitor's native side defines `window.Capacitor` before
 * any script of the page runs, so the check is synchronous and needs no
 * import: the web page at m.caprock.dev and the dashboard a daemon serves
 * never load a line of the native code (`ui/src/native/`), which is reached
 * only through dynamic imports behind this check.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

function cap(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
}

/** True inside the iOS app; false on every web page and in the desktop app. */
export function isNativeApp(): boolean {
  try {
    return cap()?.isNativePlatform?.() === true
  } catch {
    return false
  }
}

/**
 * Whether the page may offer anything for sale. Never in the iOS app: it
 * neither sells Premium nor points to where it is sold (ADR-083), so every
 * price, buy link and upgrade prompt asks this first.
 */
export function sellsHere(): boolean {
  return !isNativeApp()
}
