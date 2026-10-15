/**
 * What the desktop app hands the dashboard's Pipeline page (screens/Pipeline.tsx)
 * that a browser tab does not have: the sessions it already holds (so the page
 * asks for none), the worktrees an agent can be started in for a red pull
 * request, a toast, and the way back to where ⇧⌘B was pressed. In a browser
 * every field is absent and the page reads the sessions itself.
 */
import { createContext } from 'react'
import type { SessionSummary, SpawnRequest } from './api'
import type { DeckWorktree } from './prforce'

export interface PipelineHost {
  sessions?: readonly SessionSummary[]
  worktreesOf?: (sessionId: string) => DeckWorktree[] | undefined
  onStartAgent?: (req: SpawnRequest, title: string, of: string) => Promise<void>
  onToast?: (text: string) => void
  /** Back to the tab or screen ⇧⌘B was pressed on. */
  onBack?: () => void
}

export const PipelineHostContext = createContext<PipelineHost>({})
