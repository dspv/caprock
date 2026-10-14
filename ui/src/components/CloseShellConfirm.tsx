/**
 * The question before closing a shell that is running a program — "Shell 1
 * is running claude. Close and stop it?" — as iTerm, Terminal and VS Code
 * ask it (.ai/21-app.md § Shell tabs). An idle shell never gets here: its tab
 * closes and the shell ends with it. *Close project* asks the same way about
 * all its busy shells at once (`project`).
 */
import { useState } from 'react'
import { Sheet, SheetButton, SHEET_CLOSE_ROOM } from './Sheet'
import { AGENT_END_QUESTION, CHAT_CLOSE_QUESTION, closeQuestion, projectCloseQuestion, type ClosingShell } from '@/lib/closeShell'

/**
 * The one question before closing a quick chat that is still answering
 * (.ai/21-app.md § Quick chat). An idle chat never gets here: its tab
 * closes and the chat ends with it.
 */
export function CloseChatConfirm({ onStop, onKeep, onCancel, agent = false }: {
  onStop: () => void
  onKeep: () => void
  onCancel: () => void
  /** An agent Caprock started, chosen to end with its tab, rather than a quick chat. */
  agent?: boolean
}) {
  return (
    <Sheet
      label={agent ? 'End an agent that is answering' : 'Close a chat that is answering'}
      width={420}
      onClose={onCancel}
      footer={
        <>
          <SheetButton onClick={onCancel}>Cancel</SheetButton>
          <SheetButton onClick={onKeep}>Keep it running, close tab</SheetButton>
          <button type="button" autoFocus onClick={onStop}
            className="h-[30px] rounded-[7px] bg-danger px-3.5 text-[13px] font-medium text-white hover:brightness-110">
            Stop and close
          </button>
        </>
      }
    >
      <div className={`grid gap-1.5 py-4 pl-5 ${SHEET_CLOSE_ROOM}`}>
        <p className="text-[13.5px] font-medium text-fg">{agent ? AGENT_END_QUESTION : CHAT_CLOSE_QUESTION}</p>
        <p className="text-[12.5px] text-fg-muted">
          {agent
            ? 'Stopping ends its process; the conversation is kept and can be continued. Kept running, it stays in the sidebar under Running, no tab.'
            : 'Stopping ends its process; the conversation is kept and can be continued. Kept running, it stays under Outside projects.'}
        </p>
      </div>
    </Sheet>
  )
}

/**
 * Closing the tab of an agent Caprock started (lib/agentClose.ts): *Close
 * tab* is focused, so ⌘W then Enter only closes the tab and the agent runs
 * on; *Close and end the agent* ends it (one more question if it is still
 * answering). *Don't ask again* keeps the choice for this browser.
 */
export function CloseAgentChoice({ title, many, onKeep, onEnd, onCancel }: {
  /** The tab's name, for the question. */
  title: string
  /** More than one agent in the closing tab (a split). */
  many: boolean
  onKeep: (remember: boolean) => void
  onEnd: (remember: boolean) => void
  onCancel: () => void
}) {
  const [remember, setRemember] = useState(false)
  return (
    <Sheet
      label="Close an agent's tab"
      width={520}
      onClose={onCancel}
      footer={
        <>
          <label className="mr-auto flex shrink-0 items-center whitespace-nowrap gap-1.5 text-[12.5px] text-fg-muted">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Don&rsquo;t ask again
          </label>
          <SheetButton onClick={() => onEnd(remember)}>{many ? 'Close and end the agents' : 'Close and end the agent'}</SheetButton>
          <button type="button" autoFocus onClick={() => onKeep(remember)}
            className="h-[34px] shrink-0 whitespace-nowrap rounded-[7px] bg-accent px-4 text-[14px] font-medium text-panel hover:brightness-110">
            Close tab
          </button>
        </>
      }
    >
      <div className={`grid gap-1.5 py-4 pl-5 ${SHEET_CLOSE_ROOM}`}>
        <p className="text-[13.5px] font-medium text-fg">Close &ldquo;{title}&rdquo;?</p>
        <p className="text-[12.5px] text-fg-muted">
          Close tab keeps {many ? 'its agents' : 'its agent'} running, listed in the sidebar under Running, no tab. Ending stops the process; the conversation is kept and can be continued. Change this in Settings → Closing a tab.
        </p>
      </div>
    </Sheet>
  )
}

export function CloseShellConfirm({ busy, project, onStop, onKeep, onCancel }: {
  busy: readonly ClosingShell[]
  /** Closing a whole project: its name, for the question and the buttons. */
  project?: string
  /** Stop and close: end the shells, close the tab. */
  onStop: () => void
  /** Keep running: the shell stays, a muted row with ■ in the sidebar. */
  onKeep: () => void
  onCancel: () => void
}) {
  const many = busy.length > 1
  return (
    <Sheet
      label="Close a running shell"
      width={440}
      onClose={onCancel}
      footer={
        <>
          <SheetButton onClick={onCancel}>Cancel</SheetButton>
          <SheetButton onClick={onKeep}>{project ? `Keep ${many ? 'them' : 'it'} running, close tabs` : 'Keep running, close tab'}</SheetButton>
          <button
            type="button"
            autoFocus
            onClick={onStop}
            className="h-[30px] rounded-[7px] bg-danger px-3.5 text-[13px] font-medium text-white hover:brightness-110"
          >
            Stop and close
          </button>
        </>
      }
    >
      <div className={`grid gap-1.5 py-4 pl-5 ${SHEET_CLOSE_ROOM}`}>
        <p className="text-[13.5px] font-medium text-fg">{project ? projectCloseQuestion(project, busy) : closeQuestion(busy)}</p>
        <p className="text-[12.5px] text-fg-muted">
          Stopping ends {many ? 'the shells and what they run' : 'the shell and what it runs'}. Kept running, {many ? 'they stay' : 'it stays'} in the sidebar as a muted row, to open again or stop with ■.
        </p>
      </div>
    </Sheet>
  )
}
