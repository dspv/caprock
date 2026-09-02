import { useEffect, useState } from 'react'
import { Shell } from '@/components/Shell'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useRoute } from '@/lib/router'
import { api, ApiError } from '@/lib/api'
import { NowScreen } from '@/screens/Now'
import { SessionScreen } from '@/screens/Session'
import { CostScreen } from '@/screens/Cost'
import { StatusScreen } from '@/screens/Status'
import { HistoryScreen } from '@/screens/History'
import { TasksScreen } from '@/screens/Tasks'
import { OrchestrationScreen } from '@/screens/Orchestration'
import { NotesScreen } from '@/screens/Notes'
import { PairScreen } from '@/screens/Pair'

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
    <Shell route={route}>
      <ErrorBoundary label={route.name}>
        {route.name === 'now' && <NowScreen />}
        {route.name === 'session' && <SessionScreen key={route.id} id={route.id} tab={route.tab} at={route.at} />}
        {route.name === 'cost' && <CostScreen />}
        {route.name === 'settings' && <StatusScreen />}
        {route.name === 'history' && <HistoryScreen />}
        {route.name === 'tasks' && <TasksScreen />}
        {route.name === 'graph' && <OrchestrationScreen />}
        {route.name === 'notes' && <NotesScreen />}
      </ErrorBoundary>
    </Shell>
  )
}
