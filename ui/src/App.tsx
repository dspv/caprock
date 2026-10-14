import { lazy, Suspense, useEffect, useState } from 'react'
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
import { NewProjectScreen } from '@/components/NewProject'
import { PhoneHome } from '@/components/PhoneHome'
import { LanOnlyNotice } from '@/components/LanOnlyNotice'
import { useNarrowScreen } from '@/lib/phone'
import { BrainCaptureHost } from '@/components/BrainCapture'

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
    </>
  )
}

/** The dashboard's screens in their shell: the browser's whole page, and a view inside the app. */
export function Dashboard({ route, inApp = false }: { route: Route; inApp?: boolean }) {
  // At phone width the browser's home is the phone home (.ai/04-ui.md § The
  // phone home): start a chat, save, continue. The full Now screen is #/now.
  const narrow = useNarrowScreen()
  const phoneHome = narrow && !inApp && route.name === 'now' && !route.full
  return (
    <Shell route={route}>
      {!inApp && <LanOnlyNotice />}
      <ErrorBoundary label={route.name}>
        {route.name === 'now' && (phoneHome ? <PhoneHome /> : <NowScreen inApp={inApp} />)}
        {route.name === 'session' && <SessionScreen key={route.id} id={route.id} tab={route.tab} at={route.at} />}
        {route.name === 'cost' && <CostScreen section={route.section} />}
        {route.name === 'settings' && <StatusScreen />}
        {route.name === 'history' && <HistoryScreen />}
        {route.name === 'week' && <WeekScreen start={route.start} />}
        {route.name === 'tasks' && <TasksScreen view={route.view} />}
        {route.name === 'graph' && <OrchestrationScreen />}
        {route.name === 'notes' && <NotesScreen />}
        {route.name === 'start' && <NewProjectScreen mode={route.mode} />}
        {route.name === 'mail' && <Suspense fallback={null}><MailScreen /></Suspense>}
        {route.name === 'brain' && <Suspense fallback={null}><BrainScreen node={route.node} /></Suspense>}
      </ErrorBoundary>
    </Shell>
  )
}
