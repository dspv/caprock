import { lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Shell } from '@/components/Shell'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useRoute, type Route } from '@/lib/router'
import { api, ApiError, isPairedDevice } from '@/lib/api'
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
import { PipelineScreen } from '@/screens/Pipeline'
import { WorkScreen } from '@/screens/Work'
import { ChatsScreen } from '@/screens/Chats'
import { ChatScreen } from '@/screens/Chat'
import { MachineScreen } from '@/screens/Machine'
import { NewProjectScreen } from '@/components/NewProject'
import { PhoneHome } from '@/components/PhoneHome'
import { LanOnlyNotice } from '@/components/LanOnlyNotice'
import { ComputerAsks } from '@/components/ComputerAsks'
import { useNarrowScreen } from '@/lib/phone'
import { BrainCaptureHost } from '@/components/BrainCapture'
import { ScreenShown } from '@/lib/refresh'
import { PipelineHostContext } from '@/lib/pipelineHost'
import { keptScreen, pageScroller, placeKey, useScrollPlace } from '@/lib/screenPlace'
import { MailWindowBanner } from '@/screens/mail/MailWindowBanner'

// Mail is its own world (internal/mail); its code loads only when opened.
const MailScreen = lazy(() => import('@/screens/mail/MailScreen').then((m) => ({ default: m.MailScreen })))
// A private module's screen (ADR-076); only an admin key ever opens it.
const ModuleScreen = lazy(() => import('@/screens/ModuleScreen').then((m) => ({ default: m.ModuleScreen })))
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

/** Asks for a device that holds a token before a 401 is believed. */
export const PAIRED_401_TRIES = 3

/**
 * What one failed startup check means: the pairing form, the dashboard, or
 * ask again. A device holding a token was paired, and one 401 does not undo
 * that (owner, 2026-10-14, translated: "my connection to Caprock dropped and
 * it asks me to go to Caprock settings again"). On the phone's page the
 * channel confirms a removal itself (remote/transport) and says so, so the
 * dashboard carries on; a tablet on the Wi-Fi asks PAIRED_401_TRIES times.
 */
export function accessAfter(err: unknown, o: { paired: boolean; remote: boolean; tries: number }): Access | 'retry' {
  // 401 is the daemon saying "prove which device you are". Anything else —
  // the daemon is down, the network dropped — is a problem the normal
  // screens already explain, and hiding them behind a pairing form would
  // send someone hunting for a code that would not have helped.
  if (!(err instanceof ApiError && err.status === 401)) return 'ok'
  if (!o.paired) return 'needs-pairing'
  if (o.remote) return 'ok'
  return o.tries >= PAIRED_401_TRIES ? 'needs-pairing' : 'retry'
}

export default function App() {
  const route = useRoute()
  const [access, setAccess] = useState<Access>('checking')

  useEffect(() => {
    let live = true
    let timer = 0
    let tries = 0
    const ask = () => {
      api
        .status()
        .then(() => live && setAccess('ok'))
        .catch((e) => {
          if (!live) return
          tries++
          const next = accessAfter(e, { paired: isPairedDevice(), remote: import.meta.env.VITE_CAPROCK_REMOTE === '1', tries })
          if (next === 'retry') timer = window.setTimeout(ask, 1500 * tries)
          else setAccess(next)
        })
    }
    ask()
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [])

  if (access === 'checking') return null
  if (access === 'needs-pairing') return <PairScreen />

  return (
    <>
      <Dashboard route={route} />
      {/* The quick capture, opened from anywhere on the page (lib/brain.ts). */}
      <BrainCaptureHost />
      {/* Another computer asking to control this one (ADR-067). */}
      <ComputerAsks />
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
      case 'mail': return <><div className="mb-3"><MailWindowBanner shortcut={false} /></div><Suspense fallback={null}><MailScreen /></Suspense></>
      case 'brain': return <Suspense fallback={null}><BrainScreen node={r.node} /></Suspense>
      case 'pipeline': return <PipelineScreen repo={r.repo} of={r.of} pr={r.pr} />
      case 'work': return <WorkScreenHosted />
      case 'chats': return <ChatsScreen key={r.archived ? 'archived' : 'open'} archived={r.archived} />
      case 'chat': return <ChatScreen key={r.id} id={r.id} />
      case 'module': return <Suspense fallback={null}><ModuleScreen key={r.id} id={r.id} to={r.to} /></Suspense>
      case 'machine': return <MachineScreen key={`${r.id}/${r.session ?? ''}`} id={r.id} session={r.session} tab={r.tab} />
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

/** Work, with the app's way to bring a session's tab forward (lib/pipelineHost); in a browser, a session's page. */
function WorkScreenHosted() {
  const host = useContext(PipelineHostContext)
  return <WorkScreen onOpenSession={host.onOpenSession} />
}
