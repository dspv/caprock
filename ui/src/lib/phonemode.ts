/**
 * Phone mode for a browser tab (the in-app browser, beta, ADR-075 amended
 * 2026-10-21): the page's own window sized to a phone's page area, drawn
 * inside a simple device frame, with the phone's user agent and, when Touch
 * is on, the mouse acting as a finger.
 *
 * The page area is truly that size: the shell sizes the page's window to it
 * (app/src-tauri/src/browser.rs), so media queries, innerWidth/innerHeight
 * and 100vh/100dvh read the device's numbers. Everything else — the status
 * bar, the browser's bars, the home indicator — is drawn by the dashboard
 * around it and is a picture.
 *
 * Numbers. The screens (CSS px) and DPRs: iPhone 16 and iPhone SE (3rd gen)
 * from Apple's published resolutions (2556×1179 at 3×; 1334×750 at 2×);
 * Pixel 9 and Galaxy S24 from the published panels (1080×2424; 1080×2340)
 * divided by the usual default DPR (2.625; 3), which depends on the phone's
 * display-size setting — unverified. The bars' heights (status bar, Safari's
 * and Chrome's bars, the home indicator) are estimates nobody has measured
 * on a phone yet, so every page height built from them says `est.` (rule 6;
 * .ai/12-risks.md). The page's width is the screen's and is not an estimate.
 *
 * Pure helpers and the per-viewer preferences; components/PhoneFrame.tsx
 * draws the frame and components/BrowserView.tsx carries the mode.
 */

export type DeviceId = 'iphone16' | 'iphonese' | 'pixel9' | 's24' | 'custom'

export interface Device {
  id: DeviceId
  /** As the picker names it. */
  name: string
  browser: 'Safari' | 'Chrome'
  /** The screen in CSS px, portrait. */
  w: number
  h: number
  dpr: number
  /** The status bar (portrait). */
  top: number
  /** Chrome's top bar, shown; scrolled away it is 0. */
  topBar: number
  /** Safari's bottom bar, shown; scrolled away a slim strip of `bottomSlim` stays. */
  bottomBar: number
  bottomSlim: number
  /** The home indicator or gesture bar; 0 for a home button. */
  nav: number
  navKind: 'home' | 'gesture' | 'button'
  cutout: 'island' | 'punch' | 'none'
  /** The frame's corner radius and bezel, CSS px: a picture. */
  radius: number
  bezel: number
  /** The user agent sent and read by scripts. */
  ua: string
  /** The user agent in a word, for the readout. */
  uaName: string
}

/**
 * iOS Safari's user agent (iOS 18), and Chrome on Android's reduced one —
 * Chrome sends `Android 10; K` for every phone since its UA reduction, so
 * the model is no part of it.
 */
export const IOS_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
export const ANDROID_CHROME_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

export const DEVICES: readonly Device[] = [
  { id: 'iphone16', name: 'iPhone 16', browser: 'Safari', w: 393, h: 852, dpr: 3, top: 54, topBar: 0, bottomBar: 83, bottomSlim: 32, nav: 34, navKind: 'home', cutout: 'island', radius: 55, bezel: 11, ua: IOS_SAFARI_UA, uaName: 'Safari · iOS 18' },
  { id: 'iphonese', name: 'iPhone SE (3rd gen)', browser: 'Safari', w: 375, h: 667, dpr: 2, top: 20, topBar: 0, bottomBar: 94, bottomSlim: 32, nav: 0, navKind: 'button', cutout: 'none', radius: 44, bezel: 12, ua: IOS_SAFARI_UA, uaName: 'Safari · iOS 18' },
  { id: 'pixel9', name: 'Pixel 9', browser: 'Chrome', w: 412, h: 923, dpr: 2.625, top: 40, topBar: 56, bottomBar: 0, bottomSlim: 0, nav: 24, navKind: 'gesture', cutout: 'punch', radius: 42, bezel: 10, ua: ANDROID_CHROME_UA, uaName: 'Chrome · Android' },
  { id: 's24', name: 'Galaxy S24', browser: 'Chrome', w: 360, h: 780, dpr: 3, top: 36, topBar: 56, bottomBar: 0, bottomSlim: 0, nav: 24, navKind: 'gesture', cutout: 'punch', radius: 40, bezel: 10, ua: ANDROID_CHROME_UA, uaName: 'Chrome · Android' },
]

/** The bounds a custom page may take, CSS px. */
export const CUSTOM_MIN = 200
export const CUSTOM_MAX = 2000

/** A custom page: exactly W×H, no bars, Chrome on Android's user agent. */
export function customDevice(w: number, h: number): Device {
  const cw = clampSide(w)
  const ch = clampSide(h)
  return { id: 'custom', name: `Custom ${cw}×${ch}`, browser: 'Chrome', w: cw, h: ch, dpr: 0, top: 0, topBar: 0, bottomBar: 0, bottomSlim: 0, nav: 0, navKind: 'gesture', cutout: 'none', radius: 18, bezel: 8, ua: ANDROID_CHROME_UA, uaName: 'Chrome · Android' }
}

export function clampSide(n: number): number {
  return Number.isFinite(n) ? Math.round(Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, n))) : 390
}

// ---------------------------------------------------------------------------
// The preferences (this viewer's, localStorage)

export type Bars = 'shown' | 'hidden'

export interface PhonePrefs {
  device: DeviceId
  rotate: boolean
  bars: Bars
  touch: boolean
  customW: number
  customH: number
}

export const PHONE_PREFS_KEY = 'caprock.app.browser-phone'

export const DEFAULT_PHONE_PREFS: PhonePrefs = { device: 'iphone16', rotate: false, bars: 'shown', touch: true, customW: 390, customH: 700 }

export function loadPhonePrefs(): PhonePrefs {
  try {
    const raw = localStorage.getItem(PHONE_PREFS_KEY)
    if (!raw) return DEFAULT_PHONE_PREFS
    const p = JSON.parse(raw) as Partial<PhonePrefs>
    const ids: DeviceId[] = ['iphone16', 'iphonese', 'pixel9', 's24', 'custom']
    return {
      device: ids.includes(p.device as DeviceId) ? (p.device as DeviceId) : DEFAULT_PHONE_PREFS.device,
      rotate: p.rotate === true,
      bars: p.bars === 'hidden' ? 'hidden' : 'shown',
      touch: p.touch !== false,
      customW: clampSide(Number(p.customW ?? DEFAULT_PHONE_PREFS.customW)),
      customH: clampSide(Number(p.customH ?? DEFAULT_PHONE_PREFS.customH)),
    }
  } catch {
    return DEFAULT_PHONE_PREFS
  }
}

export function savePhonePrefs(p: PhonePrefs): void {
  try { localStorage.setItem(PHONE_PREFS_KEY, JSON.stringify(p)) } catch { /* private window: this page only */ }
}

/** The device the preferences name. */
export function deviceOf(p: Pick<PhonePrefs, 'device' | 'customW' | 'customH'>): Device {
  if (p.device === 'custom') return customDevice(p.customW, p.customH)
  return DEVICES.find((d) => d.id === p.device) ?? DEVICES[0]!
}

/** Which tabs are in phone mode, by their key: for as long as the window lives. */
const phoneTabs = new Map<string, boolean>()
export function phoneOn(pageKey: string): boolean { return phoneTabs.get(pageKey) === true }
/** On or off as last chosen this window; undefined when never chosen (a phone preview then starts on). */
export function phoneChosen(pageKey: string): boolean | undefined { return phoneTabs.get(pageKey) }
export function setPhoneOn(pageKey: string, on: boolean): void {
  phoneTabs.set(pageKey, on)
}

/**
 * A phone preview (lib/devservers): Phone mode on for `pageKey`, on the
 * device used last (iPhone 16 the first time), with Touch on.
 */
export function startPhonePreview(pageKey: string): void {
  setPhoneOn(pageKey, true)
  const p = loadPhonePrefs()
  if (!p.touch) savePhonePrefs({ ...p, touch: true })
}

// ---------------------------------------------------------------------------
// The layout

/** One band of the screen, top to bottom, in CSS px of the device. */
export interface Band {
  kind: 'status' | 'topbar' | 'page' | 'bottombar' | 'nav'
  h: number
}

export interface Layout {
  /** The screen, as held. */
  screenW: number
  screenH: number
  /** The page area: what the page's window is sized to. */
  pageW: number
  pageH: number
  /** The page's height is built from estimated bars. */
  est: boolean
  bands: Band[]
}

/**
 * The screen as held, its bands, and the page area they leave. Portrait:
 * status bar, Chrome's top bar (shown, or gone scrolled away), the page,
 * Safari's bottom bar (shown, or a slim strip scrolled away), the home
 * indicator. Landscape: no status bar; the bars thinner (48 shown, 0 away);
 * an iPhone with an island keeps 59 px clear each side. All estimates.
 */
export function layoutOf(d: Device, bars: Bars, rotate: boolean): Layout {
  if (d.id === 'custom') {
    const [w, h] = rotate ? [d.h, d.w] : [d.w, d.h]
    return { screenW: w, screenH: h, pageW: w, pageH: h, est: false, bands: [{ kind: 'page', h }] }
  }
  const shown = bars === 'shown'
  const bands: Band[] = []
  if (!rotate) {
    const top = d.topBar && shown ? d.topBar : 0
    const bottom = d.bottomBar ? (shown ? d.bottomBar : d.bottomSlim) : 0
    bands.push({ kind: 'status', h: d.top })
    if (top) bands.push({ kind: 'topbar', h: top })
    const pageH = d.h - d.top - top - bottom - d.nav
    bands.push({ kind: 'page', h: pageH })
    if (bottom) bands.push({ kind: 'bottombar', h: bottom })
    if (d.nav) bands.push({ kind: 'nav', h: d.nav })
    return { screenW: d.w, screenH: d.h, pageW: d.w, pageH, est: true, bands }
  }
  const bar = shown ? 48 : 0
  const nav = d.navKind === 'home' ? 21 : d.navKind === 'gesture' ? 16 : 0
  if (d.topBar && bar) bands.push({ kind: 'topbar', h: bar })
  const pageH = d.w - bar - nav
  bands.push({ kind: 'page', h: pageH })
  if (d.bottomBar && bar) bands.push({ kind: 'bottombar', h: bar })
  if (nav) bands.push({ kind: 'nav', h: nav })
  const pageW = d.h - (d.cutout === 'island' ? 2 * 59 : 0)
  return { screenW: d.h, screenH: d.w, pageW, pageH, est: true, bands }
}

/** What the SE's chin and forehead add around its screen, portrait. */
export const SE_FOREHEAD = 62
export const SE_CHIN = 74

/** The whole frame's size around a layout, CSS px of the device. */
export function frameSize(d: Device, l: Layout, rotate: boolean): { w: number; h: number } {
  const se = d.navKind === 'button' && d.id !== 'custom'
  if (se && !rotate) return { w: l.screenW + 2 * 14, h: l.screenH + SE_FOREHEAD + SE_CHIN }
  if (se && rotate) return { w: l.screenW + SE_FOREHEAD + SE_CHIN, h: l.screenH + 2 * 14 }
  return { w: l.screenW + 2 * d.bezel, h: l.screenH + 2 * d.bezel }
}

/**
 * How the frame is drawn in a box of `avail` logical px: `full`, the whole
 * phone; `page`, the page area alone in a thin rim (the bars are named, not
 * drawn) when the phone is taller or wider than the box; `over`, even the
 * page area does not fit — it keeps its true size and runs past the box,
 * and the bar says so. The page area is never scaled: its size is the point.
 */
export type Fit = 'full' | 'page' | 'over'
export const FIT_MARGIN = 16
export const PAGE_RIM = 6

export function fitOf(frame: { w: number; h: number }, page: { w: number; h: number }, avail: { w: number; h: number }): Fit {
  const room = (w: number, h: number) => w + 2 * FIT_MARGIN <= avail.w && h + 2 * FIT_MARGIN <= avail.h
  if (room(frame.w, frame.h)) return 'full'
  if (room(page.w + 2 * PAGE_RIM, page.h + 2 * PAGE_RIM)) return 'page'
  return 'over'
}

/** What the shell is told for the page in phone mode (browser.rs `Phone`). */
export interface PhoneSpec {
  ua: string
  touch: boolean
}

export function phoneSpec(d: Device, touch: boolean): PhoneSpec {
  return { ua: d.ua, touch }
}

// ---------------------------------------------------------------------------
// How true it is

export type Truth = 'real' | 'approx' | 'no'
export type HostOs = 'mac' | 'win' | 'lin'

/**
 * The honest list under the device bar's ?, per host OS (from the approved
 * mockup, cut to what is built: no keyboard, and on Windows the same touch
 * script as elsewhere — WebView2's DevTools emulation is not wired yet).
 */
export const TRUTH: Record<HostOs, [Truth, string, string][]> = {
  mac: [
    ['real', 'Width and height', 'the page window is sized to the device, so media queries, innerWidth/innerHeight and 100vh/100dvh read the device numbers (the height is an estimate of what the bars leave)'],
    ['real', 'User agent', 'the device browser\'s string, for server and script sniffing; changing the device reloads the page'],
    ['real', 'Rotate', 'the window swaps sides; orientation media queries follow'],
    ['approx', 'Touch', 'a script turns the mouse into touch-type pointer events and scrolls by dragging, with momentum. Libraries listening to pointer events (most sheets and carousels) work; touchstart/touchend do not exist on macOS WebKit; momentum is the script\'s, not WebKit\'s; :hover still applies'],
    ['approx', 'Bars scrolled away', 'a second size, chosen by hand — the bars do not collapse as you scroll, and 100svh/100lvh both equal the current height'],
    ['approx', 'Safe areas', 'the frame keeps the page out from under the island and home bar (as Safari does without viewport-fit=cover); env(safe-area-inset-*) reads 0'],
    ['no', 'devicePixelRatio', 'stays this screen\'s; a 3× srcset is not picked'],
    ['no', 'Engine', 'macOS WebKit is close to iOS Safari but not it; Chrome on Android is not emulated by WebKit at all'],
    ['no', 'Meta viewport, pinch zoom, the on-screen keyboard, a real finger', ''],
  ],
  win: [
    ['real', 'Width and height', 'the page window is sized to the device (the height is an estimate of what the bars leave)'],
    ['real', 'User agent', 'set through WebView2; changing the device reloads the page'],
    ['real', 'Rotate', 'the window swaps sides'],
    ['approx', 'Touch', 'the same pointer script as on macOS, not Chromium\'s own touch emulation (DevTools protocol), which is not wired yet: no touchstart/touchend'],
    ['approx', 'Bars scrolled away and safe areas', 'as on macOS'],
    ['no', 'devicePixelRatio', 'stays this screen\'s'],
    ['no', 'Safari', 'an iPhone preset on Windows is Chromium wearing an iPhone size and user agent'],
    ['no', 'Meta viewport, pinch zoom, the on-screen keyboard, a real finger', ''],
  ],
  lin: [
    ['real', 'Width, height, user agent, rotate', 'as on macOS (Wayland may not let the page window be placed over the frame)'],
    ['approx', 'Touch', 'the same pointer script as on macOS'],
    ['approx', 'Bars scrolled away and safe areas', 'as on macOS'],
    ['no', 'devicePixelRatio', 'is the screen\'s'],
    ['no', 'Engine', 'WebKitGTK is neither iOS Safari nor Android Chrome'],
  ],
}

export function hostOs(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): HostOs {
  if (/^Mac/i.test(platform)) return 'mac'
  if (/^Win/i.test(platform)) return 'win'
  return 'lin'
}
