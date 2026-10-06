import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted brand faces (same as caprock.dev) — bundled, never fetched at
// runtime, so the dashboard stays local-first with no outbound calls.
import '@fontsource-variable/hanken-grotesk'
import '@fontsource-variable/jetbrains-mono'
import '@/design/tokens.css'
import { isAppMode, isTrayRoute } from '@/lib/appmode'
import { loadTerminalFont } from '@/lib/termfont'

// The app opens on terminals: start fetching every subset of their face now,
// while the workspace chunk is still loading (lib/termfont).
if (isAppMode() && !isTrayRoute()) loadTerminalFont()

// Two entry points from one bundle: the dashboard, or the app's terminal-first
// workspace (WP-04). Each is its own chunk, so the app's terminal route never
// loads or renders the dashboard's screens until the dashboard is opened: the
// Tauri spike measured a terminal beside the full dashboard 4–6 ms slower to
// echo than a lean one (.ai/21-app.md § Performance budgets).
// The menu bar popover (macOS) is a third, smaller chunk: no terminal, no dashboard.
const Root = isTrayRoute()
  ? lazy(() => import('./screens/TrayPanel'))
  : isAppMode() ? lazy(() => import('./screens/AppShell')) : lazy(() => import('./App'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </StrictMode>,
)
