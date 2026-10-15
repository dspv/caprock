/**
 * The question before closing a shell that is running a program — "Shell 1
 * is running claude. Close and stop it?" — as iTerm, Terminal and VS Code
 * ask it (.ai/21-app.md § Shell tabs). An idle shell never gets here: its tab
 * closes and the shell ends with it. *Close project* asks the same way about
 * all its busy shells at once (`project`).
 */
import { Sheet, SheetButton, SHEET_CLOSE_ROOM } from './Sheet'
import { AGENT_END_QUESTION, CHAT_CLOSE_QUESTION, agentStillWorking, closeQuestion, projectCloseQuestion, type ClosingShell } from '@/lib/closeShell'

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
      width={560}
      onClose={onCancel}
      footer={
        <>
          <SheetButton onClick={onCancel}>Cancel</SheetButton>
          <SheetButton onClick={onKeep}>Keep it running, close tab</SheetButton>
          <SheetButton danger autoFocus onClick={onStop}>Stop and close</SheetButton>
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
 * Closing the tab of an agent Caprock started that is working or waiting on
 * you (lib/agentClose.ts): one sentence and one decision (owner,
 * 2026-10-15, translated: "I never understand whether data is kept and
 * which button to pick — one button"). *Close tab* is the one button, in
 * focus, so ⌘W then Enter closes the tab and the agent works on; *Stop it
 * instead* is a quiet link under it; Escape cancels. An idle agent never
 * gets here: it ends with its tab and a toast says the conversation is saved.
 */
export function CloseAgentChoice({ title, many, onKeep, onEnd, onCancel }: {
  /** The tab's name, for the sentence. */
  title: string
  /** More than one agent in the closing tab still working (a split). */
  many: boolean
  onKeep: () => void
  onEnd: () => void
  onCancel: () => void
}) {
  return (
    <Sheet
      label="Close an agent's tab"
      width={480}
      onClose={onCancel}
      footer={
        <div className="flex w-full flex-col items-end gap-1.5">
          <button type="button" autoFocus onClick={onKeep}
            className="h-[34px] shrink-0 whitespace-nowrap rounded-[7px] bg-accent px-5 text-[14px] font-medium text-panel hover:brightness-110">
            Close tab
          </button>
          <button type="button" data-stop-instead onClick={onEnd}
            className="rounded-[4px] px-1 text-[12.5px] text-fg-muted underline decoration-fg-faint underline-offset-2 hover:text-fg">
            {many ? 'Stop them instead' : 'Stop it instead'}
          </button>
        </div>
      }
    >
      <p className={`py-4 pl-5 text-[13.5px] leading-[1.5] text-fg ${SHEET_CLOSE_ROOM}`}>{agentStillWorking(title, many)}</p>
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
      width={560}
      onClose={onCancel}
      footer={
        <>
          <SheetButton onClick={onCancel}>Cancel</SheetButton>
          <SheetButton onClick={onKeep}>{project ? `Keep ${many ? 'them' : 'it'} running, close tabs` : 'Keep running, close tab'}</SheetButton>
          <SheetButton danger autoFocus onClick={onStop}>Stop and close</SheetButton>
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
