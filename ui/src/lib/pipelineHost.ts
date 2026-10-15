/**
 * What the desktop app hands the dashboard's Pipeline page (screens/Pipeline.tsx)
 * that a browser tab does not have: the sessions it already holds (so the page
 * asks for none), the worktrees an agent can be started in for a red pull
 * request, a toast, and the way back to where ⌘P was pressed. Work and Home's
 * Work strip take `onOpenSession` from it, so a session row brings its tab
 * forward; Home's live session rows take that, the tab's ⌘N, *End* and
 * `onStartAgent` (for *Continue in Caprock*). In a browser every field is
 * absent: the page reads the sessions itself, and a session row opens the
 * session's page.
 */
import { createContext } from 'react'
import type { SessionSummary, SpawnRequest } from './api'
import type { DeckWorktree } from './prforce'

export interface PipelineHost {
  sessions?: readonly SessionSummary[]
  worktreesOf?: (sessionId: string) => DeckWorktree[] | undefined
  onStartAgent?: (req: SpawnRequest, title: string, of: string) => Promise<void>
  onToast?: (text: string) => void
  /** Back to the tab or screen ⌘P was pressed on. */
  onBack?: () => void
  /** Brings a session's tab forward, opening one if needed (Work, Home's Work strip). */
  onOpenSession?: (sessionId: string) => void
  /** The ⌘N of the tab showing a session: null past ⌘9's reach, undefined
   *  when no tab shows it (Home's live rows, lib/sessionJump.ts). */
  tabDigitOf?: (sessionId: string) => number | null | undefined
  /** Ends a session Caprock started, as *Close and end the agent* does
   *  (`kill`), closing a tab that shows only it. Never one it did not start. */
  onEndSession?: (sessionId: string) => void
}

export const PipelineHostContext = createContext<PipelineHost>({})
