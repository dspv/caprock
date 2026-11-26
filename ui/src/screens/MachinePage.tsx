/**
 * The machine page (ADR-067): one of another computer's sessions, drawn by
 * this dashboard in a frame of the local one (screens/Machine.tsx), at
 * `/?machine=<id>#/session/<sid>`.
 *
 * main.tsx has already made every `/v1/…` request and socket of this page go
 * to that computer through this daemon's `/v1/m/<id>/…` proxy
 * (lib/machines.ts installMachineProxy), so the Session view and its terminal
 * here are the ordinary ones: they read and type into the other computer as
 * this machine's paired device there, with the role its owner gave it.
 *
 * A shell there — a setup step's, opened by *Show output* on the computer's
 * page (#1088) — is no session: it has no row, so it is drawn as its
 * terminal alone.
 *
 * Only a session is shown here. Any other screen a link inside it opens —
 * Home, Cost, a pipeline — would be the other computer's, in a frame that has
 * no way back, so the page hands the window that holds it that computer's
 * list of sessions instead.
 */
import { useEffect } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useRoute } from '@/lib/router'
import { machinePageId } from '@/lib/machinepage'
import { SessionScreen } from './Session'
import { TerminalView } from '@/components/Terminal'
import { useApi } from '@/lib/useApi'
import { projectsApi } from '@/lib/projects'

export default function MachinePage() {
  const route = useRoute()
  const id = machinePageId()
  const elsewhere = route.name !== 'session'
  useEffect(() => {
    if (!elsewhere) return
    try {
      if (window.parent !== window) window.parent.location.hash = `#/m/${id}`
    } catch { /* not ours to steer */ }
  }, [elsewhere, id])
  // The other computer's shells: one of them is drawn as its terminal.
  const shells = useApi(() => (route.name === 'session' ? projectsApi.shells().catch(() => []) : Promise.resolve([])), [route.name === 'session' ? route.id : ''], { live: false })
  if (route.name !== 'session') return null
  if (!shells.data) return null
  if (shells.data.some((s) => s.id === route.id)) {
    return (
      <div data-machine-page={id} data-machine-shell={route.id} className="flex h-screen flex-col bg-bg">
        <ErrorBoundary label="terminal">
          <div className="relative min-h-0 flex-1"><TerminalView sessionId={route.id} owned /></div>
        </ErrorBoundary>
      </div>
    )
  }
  return (
    <div data-machine-page={id} className="min-h-screen bg-bg px-3 py-3">
      <ErrorBoundary label="session">
        <SessionScreen key={route.id} id={route.id} tab={route.tab} at={route.at} />
      </ErrorBoundary>
    </div>
  )
}
