import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted brand faces (same as caprock.dev) — bundled, never fetched at
// runtime, so the dashboard stays local-first with no outbound calls.
import '@fontsource-variable/hanken-grotesk'
import '@fontsource-variable/jetbrains-mono'
import '@/design/tokens.css'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { isAppMode, isMailApp, isTrayRoute } from '@/lib/appmode'
import { loadTerminalFont } from '@/lib/termfont'
import { watchUiVersion } from '@/lib/staleui'
import { applyUiScale } from '@/lib/uiscale'
import { markPageVisibility } from '@/lib/visible'
import { listenForInstall } from '@/remote/install'
import { installMachineProxy, machinePageId } from '@/lib/machinepage'
import { isNativeApp } from '@/native/platform'

// The app opens on terminals: start fetching every subset of their face now,
// while the workspace chunk is still loading (lib/termfont).
if (isAppMode() && !isTrayRoute() && !isMailApp()) loadTerminalFont()

// The desktop window's interface size; the popover keeps its own (lib/uiscale).
if (!isTrayRoute()) applyUiScale()

// The phone's page, built with --mode remote and served apart from any
// daemon: it reaches its machine through a relay (remote/, ADR-058).
const remote = import.meta.env.VITE_CAPROCK_REMOTE === '1'

// Another computer's session, in a frame of this dashboard (ADR-067): every
// request and socket for /v1/… goes to that computer through this daemon's
// /v1/m/<id>/… proxy, installed before anything asks (lib/machines.ts).
const machine = remote ? '' : machinePageId()
if (machine) installMachineProxy(machine)

// A daemon updated under this page: reload onto its UI (lib/staleui). Not on
// the remote page, which no daemon served, nor on the machine page, whose
// requests reach a daemon of another version on purpose.
if (!remote && !machine) watchUiVersion()

if (remote) {
  // Chrome's install prompt can fire before RemoteRoot's chunk has loaded;
  // keep it for the page's own button (remote/install).
  listenForInstall()
  // A new build of the remote page replaces its hashed files, and a page
  // opened before that asks for chunks that are gone: load the new build,
  // once a minute at most, rather than show an error.
  window.addEventListener('vite:preloadError', (e) => {
    try {
      const last = Number(sessionStorage.getItem('caprock.remote.reloadedAt') ?? 0)
      if (Date.now() - last < 60_000) return
      sessionStorage.setItem('caprock.remote.reloadedAt', String(Date.now()))
    } catch { /* storage refused: reload anyway */ }
    e.preventDefault()
    window.location.reload()
  })
}

// Out of sight, every CSS animation pauses (lib/visible, design/tokens.css).
markPageVisibility()

// Two entry points from one bundle: the dashboard, or the app's terminal-first
// workspace (WP-04). Each is its own chunk, so the app's terminal route never
// loads or renders the dashboard's screens until the dashboard is opened: the
// Tauri spike measured a terminal beside the full dashboard 4–6 ms slower to
// echo than a lean one (.ai/21-app.md § Performance budgets).
// The menu bar popover (macOS) is a third, smaller chunk: no terminal, no dashboard.
// Mail on its own (`?mail=1`) is a fourth: the inbox and nothing of Caprock.
// The same remote build inside the iOS app (ADR-083) starts in native/,
// which puts the pairing back from the Keychain, locks behind Face ID and
// offers the demo before the phone's page; the web page never loads it.
const Root = remote
  ? lazy(() => (isNativeApp() ? import('./native/NativeRoot') : import('./remote/RemoteRoot')))
  : machine
  ? lazy(() => import('./screens/MachinePage'))
  : isMailApp()
  ? lazy(() => import('./screens/mail/MailApp'))
  : isTrayRoute()
  ? lazy(() => import('./screens/TrayPanel'))
  : isAppMode() ? lazy(() => import('./screens/AppShell')) : lazy(() => import('./App'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* A throw anywhere above a screen's own boundary: a way back and a way
      * to tell us, never the blank window it used to leave. */}
    <ErrorBoundary full>
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </ErrorBoundary>
  </StrictMode>,
)
