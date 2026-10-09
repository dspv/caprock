/**
 * The question before closing a shell that is running a program — "Shell 1
 * is running claude. Close and stop it?" — as iTerm, Terminal and VS Code
 * ask it (.ai/21-app.md § Shell tabs). An idle shell never gets here: its tab
 * closes and the shell ends with it. *Close project* asks the same way about
 * all its busy shells at once (`project`).
 */
import { Sheet, SheetButton } from './Sheet'
import { closeQuestion, projectCloseQuestion, type ClosingShell } from '@/lib/closeShell'

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
      <div className="grid gap-1.5 px-5 py-4">
        <p className="text-[13.5px] font-medium text-fg">{project ? projectCloseQuestion(project, busy) : closeQuestion(busy)}</p>
        <p className="text-[12.5px] text-fg-muted">
          Stopping ends {many ? 'the shells and what they run' : 'the shell and what it runs'}. Kept running, {many ? 'they stay' : 'it stays'} in the sidebar as a muted row, to open again or stop with ■.
        </p>
      </div>
    </Sheet>
  )
}
