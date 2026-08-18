import { Shell } from '@/components/Shell'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Empty } from '@/components/ui'
import { useRoute } from '@/lib/router'
import { NowScreen } from '@/screens/Now'
import { SessionScreen } from '@/screens/Session'
import { CostScreen } from '@/screens/Cost'
import { StatusScreen } from '@/screens/Status'

export default function App() {
  const route = useRoute()
  return (
    <Shell route={route}>
      <ErrorBoundary label={route.name}>
        {route.name === 'now' && <NowScreen />}
        {route.name === 'session' && <SessionScreen key={route.id} id={route.id} tab={route.tab} />}
        {route.name === 'cost' && <CostScreen />}
        {route.name === 'settings' && <StatusScreen />}
      </ErrorBoundary>
      {route.name === 'history' && <Empty title="History arrives in Phase 1">Cross-session stats: cost per project/day/model, tool distribution, session durations.</Empty>}
      {route.name === 'tasks' && <Empty title="Tasks arrive in Phase 2">Kanban over tasks/*.md, verification-before-done, approvals queue.</Empty>}
    </Shell>
  )
}
