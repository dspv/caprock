import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted brand faces (same as caprock.dev) — bundled, never fetched at
// runtime, so the dashboard stays local-first with no outbound calls.
import '@fontsource-variable/hanken-grotesk'
import '@fontsource-variable/jetbrains-mono'
import '@/design/tokens.css'
import { isAppMode, isTrayRoute } from '@/lib/appmode'
import { loadTerminalFont } from '@/lib/termfont'
import { watchUiVersion } from '@/lib/staleui'
import { applyUiScale } from '@/lib/uiscale'
import { markPageVisibility } from '@/lib/visible'

// The app opens on terminals: start fetching every subset of their face now,
// while the workspace chunk is still loading (lib/termfont).
if (isAppMode() && !isTrayRoute()) loadTerminalFont()

// The desktop window's interface size; the popover keeps its own (lib/uiscale).
if (!isTrayRoute()) applyUiScale()

// The phone's page, built with --mode remote and served apart from any
// daemon: it reaches its machine through a relay (remote/, ADR-058).
const remote = import.meta.env.VITE_CAPROCK_REMOTE === '1'

// A daemon updated under this page: reload onto its UI (lib/staleui). Not on
// the remote page, which no daemon served.
if (!remote) watchUiVersion()

// Out of sight, every CSS animation pauses (lib/visible, design/tokens.css).
markPageVisibility()

// Two entry points from one bundle: the dashboard, or the app's terminal-first
// workspace (WP-04). Each is its own chunk, so the app's terminal route never
// loads or renders the dashboard's screens until the dashboard is opened: the
// Tauri spike measured a terminal beside the full dashboard 4–6 ms slower to
// echo than a lean one (.ai/21-app.md § Performance budgets).
// The menu bar popover (macOS) is a third, smaller chunk: no terminal, no dashboard.
const Root = remote
  ? lazy(() => import('./remote/RemoteRoot'))
  : isTrayRoute()
  ? lazy(() => import('./screens/TrayPanel'))
  : isAppMode() ? lazy(() => import('./screens/AppShell')) : lazy(() => import('./App'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
)
