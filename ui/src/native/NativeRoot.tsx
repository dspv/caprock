/**
 * The iOS app around the phone's page (ADR-083). main.tsx loads this instead
 * of remote/RemoteRoot when the page runs inside the app (native/platform).
 *
 * Before the page starts it puts the pairing back from the Keychain when the
 * WebView's storage lost it, and asks for Face ID when the lock is on. Then:
 * - **no machine yet:** the first-launch screen — pair by the camera, paste
 *   a link, or try the app on sample data;
 * - **the demo:** the dashboard on bundled sample data (native/demo), marked
 *   as sample on every screen, connected to nothing;
 * - **a machine:** the phone's page as on m.caprock.dev (RemoteRoot).
 * `#/app-settings` lays the app's own Settings over whichever is showing.
 */
import { Suspense, lazy, useEffect, useState } from 'react'
import { CaprockMark } from '@/components/AppIcons'
import { machines, parsePairLink } from '@/remote/boot'
import { ScanButton } from './ScanButton'
import { NOT_A_LINK, openPairLink } from './pairing'
import { keepPairing, lockWanted, restorePairing } from './keychain'

const RemoteRoot = lazy(() => import('@/remote/RemoteRoot'))
const DemoApp = lazy(() => import('./demo/DemoApp'))
const AppSettings = lazy(() => import('./Settings'))
const LockScreen = lazy(() => import('./LockScreen'))

/** The demo lasts until it is left or the app is closed (sessionStorage). */
export const DEMO_KEY = 'caprock.ios.demo'
/** The token the demo puts where the dashboard reads one; never a real one. */
export const DEMO_TOKEN = 'demo'
/** Away this long, the lock asks again on return. */
export const LOCK_AFTER_MS = 30_000
export const SETTINGS_HASH = '#/app-settings'

type Phase = 'starting' | 'welcome' | 'demo' | 'remote'

function demoOn(): boolean {
  try {
    return sessionStorage.getItem(DEMO_KEY) === '1'
  } catch {
    return false
  }
}

/** Leaves the demo: its flag and its token go, and the app starts over. */
export function leaveDemo() {
  try {
    sessionStorage.removeItem(DEMO_KEY)
    if (localStorage.getItem('caprock.device.token') === DEMO_TOKEN) localStorage.removeItem('caprock.device.token')
  } catch { /* nothing kept */ }
  window.location.replace(window.location.pathname + '#/')
  window.location.reload()
}

function startDemo() {
  try {
    sessionStorage.setItem(DEMO_KEY, '1')
  } catch { /* the demo lasts this page only */ }
  window.location.replace(window.location.pathname + '#/')
  window.location.reload()
}

/** Which screen to start on, once the pairing is back. Exported for the tests. */
export function startPhase(o: { demo: boolean; machines: number; pairLink: boolean }): Exclude<Phase, 'starting'> {
  if (o.pairLink) return 'remote'
  if (o.demo) return 'demo'
  return o.machines > 0 ? 'remote' : 'welcome'
}

export default function NativeRoot() {
  const [phase, setPhase] = useState<Phase>('starting')
  const [locked, setLocked] = useState(false)
  // Whether the page has been drawn since launch: behind the lock on a cold
  // start, nothing of it is.
  const [shown, setShown] = useState(false)
  const [settings, setSettings] = useState(() => window.location.hash === SETTINGS_HASH)

  useEffect(() => {
    let live = true
    void (async () => {
      const demo = demoOn()
      if (!demo) {
        // A demo token left by a demo the app was closed in is never a pairing.
        try {
          if (localStorage.getItem('caprock.device.token') === DEMO_TOKEN) localStorage.removeItem('caprock.device.token')
        } catch { /* storage refused */ }
        await restorePairing()
      }
      const lock = await lockWanted()
      if (!live) return
      setLocked(lock)
      setShown(!lock)
      setPhase(startPhase({ demo, machines: machines().length, pairLink: !!parsePairLink(window.location.hash) }))
    })()
    return () => { live = false }
  }, [])

  // The app's Settings, laid over the page.
  useEffect(() => {
    const onHash = () => setSettings(window.location.hash === SETTINGS_HASH)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Keep the Keychain's copy current, and lock again after a while away.
  useEffect(() => {
    if (phase !== 'remote') return
    let away = 0
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        away = Date.now()
        void keepPairing()
        return
      }
      if (away && Date.now() - away >= LOCK_AFTER_MS) void lockWanted().then((on) => on && setLocked(true))
      away = 0
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [phase])

  if (phase === 'starting') return <Starting />
  const page = phase === 'welcome' ? <Welcome /> : phase === 'demo' ? <DemoApp onLeave={leaveDemo} /> : <RemotePage />
  return (
    <>
      {(!locked || shown) && (
        <div inert={locked} aria-hidden={locked || undefined}>
          <Suspense fallback={<Starting />}>{page}</Suspense>
        </div>
      )}
      {settings && !locked && (
        <Suspense fallback={null}>
          <AppSettings demo={phase === 'demo'} onClose={closeSettings} />
        </Suspense>
      )}
      {locked && (
        <Suspense fallback={<div className="fixed inset-0 z-[200] bg-bg" />}>
          <LockScreen onOpen={() => { setLocked(false); setShown(true) }} />
        </Suspense>
      )}
    </>
  )
}

function closeSettings() {
  if (window.history.length > 1) window.history.back()
  else window.location.hash = '#/'
}

/** The phone's page; once it has started (remote/boot's prepare ran), the Keychain takes its copy. */
function RemotePage() {
  useEffect(() => {
    void keepPairing()
  }, [])
  return <RemoteRoot />
}

function Starting() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg" data-testid="native-starting">
      <CaprockMark size={44} />
    </div>
  )
}

/** The first-launch screen (the approved mockup's screen 1). */
export function Welcome() {
  const [error, setError] = useState('')
  const [pasting, setPasting] = useState(false)
  const [link, setLink] = useState('')
  return (
    <div data-testid="native-welcome" className="mx-auto flex min-h-dvh max-w-md flex-col bg-bg px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(3.5rem,env(safe-area-inset-top))]">
      <div className="flex flex-1 flex-col justify-center">
        <CaprockMark size={56} />
        <h1 className="mb-2.5 mt-6 text-[34px] font-semibold leading-[1.1] tracking-[-0.015em] text-fg">Your coding agents, on your phone</h1>
        <p className="text-[17px] leading-snug text-fg-muted">Every session of Caprock on your Mac: answer it, start a chat, approve, stop. From anywhere.</p>
        <ol className="mt-6 grid gap-3">
          <li className="flex gap-3 text-[15px] leading-snug text-fg-muted">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border-[1.5px] border-border-strong text-[13px] font-semibold text-fg">1</span>
            <span>On the Mac, open <b className="font-semibold text-fg">Caprock → Settings → Use on your phone → Connect a phone</b>.</span>
          </li>
          <li className="flex gap-3 text-[15px] leading-snug text-fg-muted">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border-[1.5px] border-border-strong text-[13px] font-semibold text-fg">2</span>
            <span>Scan the code it shows. That is the whole pairing.</span>
          </li>
        </ol>
      </div>
      <div className="grid gap-2.5 pt-6">
        {error && <p role="alert" className="text-[15px] leading-snug text-danger">{error}</p>}
        {pasting ? (
          <form
            className="grid gap-2.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (!openPairLink(link)) setError(NOT_A_LINK)
            }}
          >
            <label htmlFor="native-pair-link" className="text-[15px] text-fg-muted">
              On the Mac, tap <b className="font-semibold text-fg">Copy link</b> under the code, then paste it here.
            </label>
            <input
              id="native-pair-link"
              value={link}
              onChange={(e) => { setLink(e.target.value); setError('') }}
              placeholder="Paste the link"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-h-[52px] rounded-[14px] border border-border-strong bg-panel px-4 text-[16px] text-fg"
            />
            <div className="flex gap-2.5">
              <button type="submit" disabled={!link.trim()} className="min-h-[52px] flex-1 rounded-[14px] bg-accent text-[17px] font-semibold text-bg disabled:opacity-40">Pair</button>
              <button type="button" onClick={() => { setPasting(false); setError('') }} className="min-h-[52px] rounded-[14px] px-5 text-[17px] text-fg-muted">Cancel</button>
            </div>
          </form>
        ) : (
          <>
            <ScanButton label="Pair with your Mac" onError={setError} />
            <button type="button" onClick={startDemo} className="min-h-[52px] w-full rounded-[14px] border border-border-strong bg-panel text-[17px] font-semibold text-fg">
              Try it without a Mac
            </button>
            <button type="button" onClick={() => { setPasting(true); setError('') }} className="min-h-11 text-[16px] font-medium text-accent">
              Paste a link instead
            </button>
          </>
        )}
        <p className="mx-2 mt-1 text-center text-[13px] leading-snug text-fg-faint">
          The demo shows sample sessions and connects to nothing. Caprock on Windows and Linux pairs the same way.
        </p>
      </div>
    </div>
  )
}
