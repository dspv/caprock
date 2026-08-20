import { Shell } from '@/components/Shell'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useRoute } from '@/lib/router'
import { NowScreen } from '@/screens/Now'
import { SessionScreen } from '@/screens/Session'
import { CostScreen } from '@/screens/Cost'
import { StatusScreen } from '@/screens/Status'
import { HistoryScreen } from '@/screens/History'
import { TasksScreen } from '@/screens/Tasks'
import { OrchestrationScreen } from '@/screens/Orchestration'
import { NotesScreen } from '@/screens/Notes'

export default function App() {
  const route = useRoute()
  return (
    <Shell route={route}>
      <ErrorBoundary label={route.name}>
        {route.name === 'now' && <NowScreen />}
        {route.name === 'session' && <SessionScreen key={route.id} id={route.id} tab={route.tab} />}
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
