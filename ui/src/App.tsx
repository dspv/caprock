import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { Shell } from '@/components/Shell'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useRoute, type Route } from '@/lib/router'
import { api, ApiError } from '@/lib/api'
import { NowScreen } from '@/screens/Now'
import { SessionScreen } from '@/screens/Session'
import { CostScreen } from '@/screens/Cost'
import { StatusScreen } from '@/screens/Status'
import { HistoryScreen } from '@/screens/History'
import { WeekScreen } from '@/screens/Week'
import { TasksScreen } from '@/screens/Tasks'
import { OrchestrationScreen } from '@/screens/Orchestration'
import { NotesScreen } from '@/screens/Notes'
import { PairScreen } from '@/screens/Pair'
import { NewProjectScreen } from '@/components/NewProject'
import { PhoneHome } from '@/components/PhoneHome'
import { LanOnlyNotice } from '@/components/LanOnlyNotice'
import { useNarrowScreen } from '@/lib/phone'
import { BrainCaptureHost } from '@/components/BrainCapture'
import { ScreenShown } from '@/lib/refresh'
import { keptScreen, pageScroller, placeKey, useScrollPlace } from '@/lib/screenPlace'

// Mail is its own world (internal/mail); its code loads only when opened.
const MailScreen = lazy(() => import('@/screens/mail/MailScreen').then((m) => ({ default: m.MailScreen })))
// Second Brain's screen draws a graph; its code loads only when opened too.
const BrainScreen = lazy(() => import('@/screens/brain/BrainScreen').then((m) => ({ default: m.BrainScreen })))

/**
 * Whether this browser may see the figures at all.
 *
 * On the machine itself the answer is always yes and this costs one cheap
 * request at startup. From a tablet it is the difference between the dashboard
 * and a page asking for a code: the daemon serves the app's files to anyone on
 * the network — they carry no data — and answers 401 to every request for
 * figures until the device has paired.
 *
 * Asked once here rather than handled in each screen, because "not paired" is
 * not an error in a panel: it is a different page.
 */
type Access = 'checking' | 'ok' | 'needs-pairing'

export default function App() {
  const route = useRoute()
  const [access, setAccess] = useState<Access>('checking')

  useEffect(() => {
    let live = true
    api
      .status()
      .then(() => live && setAccess('ok'))
      .catch((e) => {
        if (!live) return
        // 401 is the daemon saying "prove which device you are". Anything else
        // — the daemon is down, the network dropped — is a problem the normal
        // screens already explain, and hiding them behind a pairing form would
        // send someone hunting for a code that would not have helped.
        setAccess(e instanceof ApiError && e.status === 401 ? 'needs-pairing' : 'ok')
      })
    return () => {
      live = false
    }
  }, [])

  if (access === 'checking') return null
  if (access === 'needs-pairing') return <PairScreen />

  return (
    <>
      <Dashboard route={route} />
      {/* The quick capture, opened from anywhere on the page (lib/brain.ts). */}
      <BrainCaptureHost />
    </>
  )
}

/**
 * The dashboard's screens in their shell: the browser's whole page, and a view inside the app.
 *
 * The dashboard keeps its place (lib/screenPlace.ts): a screen of its own,
 * once opened, stays mounted behind the others, and each screen's scroll is
 * put back. In the app the whole dashboard stays mounted behind the terminal
 * tabs too: `shown` is false there, and `scroller` is its scroll box.
 */
export function Dashboard({ route, inApp = false, shown = true, scroller = pageScroller }: { route: Route; inApp?: boolean; shown?: boolean; scroller?: () => HTMLElement | null }) {
  // At phone width the browser's home is the phone home (.ai/04-ui.md § The
  // phone home): start a chat, save, continue. The full Home screen is #/home.
  const narrow = useNarrowScreen()
  const screen = (r: Route): ReactNode => {
    const phoneHome = narrow && !inApp && r.name === 'now' && !r.full
    switch (r.name) {
      case 'now': return phoneHome ? <PhoneHome /> : <NowScreen inApp={inApp} />
      case 'session': return <SessionScreen key={r.id} id={r.id} tab={r.tab} at={r.at} />
      case 'cost': return <CostScreen section={r.section} />
      case 'settings': return <StatusScreen />
      case 'history': return <HistoryScreen />
      case 'week': return <WeekScreen start={r.start} />
      case 'tasks': return <TasksScreen view={r.view} />
      case 'graph': return <OrchestrationScreen />
      case 'notes': return <NotesScreen />
      case 'start': return <NewProjectScreen mode={r.mode} />
      case 'mail': return <Suspense fallback={null}><MailScreen /></Suspense>
      case 'brain': return <Suspense fallback={null}><BrainScreen node={r.node} /></Suspense>
    }
  }
  // The kept screens opened so far, each with the route it last showed.
  const kept = useRef(new Map<Route['name'], Route>())
  const front = keptScreen(route)
  if (front) kept.current.set(front, route)
  useScrollPlace(placeKey(route), shown, scroller)
  return (
    <ScreenShown.Provider value={shown}>
      <Shell route={route}>
        {!inApp && <LanOnlyNotice />}
        {[...kept.current].map(([name, r]) => (
          <div key={name} data-kept-screen={name} hidden={name !== front}>
            <ScreenShown.Provider value={shown && name === front}>
              <ErrorBoundary label={name}>{screen(r)}</ErrorBoundary>
            </ScreenShown.Provider>
          </div>
        ))}
        {/* Not kept: mounted only while in front (Settings listens for Escape on the window). */}
        {!front && shown && <ErrorBoundary label={route.name}>{screen(route)}</ErrorBoundary>}
      </Shell>
    </ScreenShown.Provider>
  )
}
