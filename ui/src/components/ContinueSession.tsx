import { useState } from 'react'
import { api, ApiError, type ResumeInfo } from '@/lib/api'
import { useCanControl } from '@/lib/useCanControl'
import { navigate } from '@/lib/router'
import { modeWords } from '@/lib/permissionMode'
import { modeOptions } from './SpawnDialog'

/**
 * Pick up a conversation that is not Caprock's to type into.
 *
 * Caprock never writes to a process it did not start — two writers on one PTY
 * interleave characters and ruin both, which is what rule 7 protects. So a
 * session someone started in their terminal is readable here and not usable,
 * and until now the only thing to do with it was look.
 *
 * `claude --resume <id>` is the way through: it starts a *second* process on
 * the same conversation, with the history read from disk. Nothing is taken
 * from the terminal that already has it, and the new process is one Caprock
 * started, so it can be typed into like any other.
 *
 * Two shapes, because the situation has two shapes:
 *
 *  - **Continue** when the session has ended. One conversation, carried on.
 *  - **Branch** when it is still running somewhere. Two live processes sharing
 *    an id would write one transcript between them and each end up holding
 *    half the other's turns, so the copy gets a new id (`--fork-session`) and
 *    the original is left alone.
 *
 * The command is also offered for a terminal of one's own, because somebody
 * who lives in tmux does not want a second place to type.
 *
 * A third shape, `detached`, is a session Caprock started whose terminal
 * closed when Caprock restarted — one started by a release from before
 * sessions outlived restarts (ADR-033), or whose terminal holder died. Its
 * process has no terminal anyone can type into, so continuing it under its
 * own id is the useful thing: the daemon stops that process first, which it
 * may, because Caprock started it. A copy alongside is offered second, for
 * someone who wants the old process left alone.
 *
 * Every shape says the permission mode the new process starts in, because
 * it is the one thing about it that is not the conversation: the daemon
 * carries on in the mode the session was last running in (`resume.
 * permission_mode`), so a session run with permissions skipped does not come
 * back asking before every command, and one that asked does not come back
 * never asking. The full shapes let it be changed before the click.
 */
export function ContinueSession({
  sessionID,
  cwd,
  live,
  resume,
  compact = false,
  detached = false,
}: {
  sessionID: string
  cwd: string
  /** Whether the session is still running: decides continue vs branch. */
  live: boolean
  /** The server's answer to "can this be resumed here", with the reason when not. */
  resume: ResumeInfo
  /** On a card: one word, the reason on hover, no copy command. */
  compact?: boolean
  /** Caprock started it and its terminal closed with a restart: lead with continue, offer a copy second. */
  detached?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  // '' is the agent's own default, offered only when nothing else was
  // recorded: picking it while a mode is recorded would be overruled by the
  // daemon, which fills an empty mode with that one.
  const carried = resume.permission_mode ?? ''
  const [mode, setMode] = useState(carried)

  // Continuing starts a process, which only a controller among paired devices
  // may do (ADR-034).
  const canControl = useCanControl()
  if (!canControl) return null

  const command = resume.command ?? ''

  async function open(fork: boolean = live) {
    setBusy(true)
    setError('')
    try {
      const req: Parameters<typeof api.spawn>[0] = { cwd, resume: sessionID, fork }
      if (mode) req.permission_mode = mode
      const res = await api.spawn(req)
      navigate({ name: 'session', id: res.session_id, tab: 'terminal' })
      // Continuing under the same id lands on the page already open, so
      // nothing navigates; the screen swaps to the live terminal on its next
      // poll. Stay "Opening…" until then rather than looking like the click
      // did nothing.
      if (res.session_id === sessionID) return
      setBusy(false)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      setBusy(false)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not reach the clipboard. Select the command and copy it.')
    }
  }

  const copyButton = command && (
    <button onClick={copy} title={command} className="text-[11px] text-fg-faint hover:text-fg">
      {copied ? 'copied' : 'copy command'}
    </button>
  )

  // The mode, said and changeable beside the button: "continue here ·
  // Bypass · never asks".
  const modePicker = (
    <select
      aria-label="Permission mode"
      value={mode}
      disabled={busy}
      onChange={(e) => setMode(e.target.value)}
      title="What the continued session may do without asking"
      className="max-w-[16rem] cursor-pointer rounded-sm border border-border bg-transparent px-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-50"
    >
      {!carried && <option value="">default mode</option>}
      {modeOptions(carried).map(([v, label]) => (
        <option key={v} value={v}>{label}</option>
      ))}
    </select>
  )

  // Not a disabled button: a greyed-out "continue" says only that something
  // is wrong. The reason is the useful part, so it is what is shown.
  if (compact) {
    if (!resume.ok) {
      return <span className="text-[11px] text-fg-faint truncate" title={resume.reason}>can’t continue</span>
    }
    // A card has no room for a picker; the mode is said, and the session's
    // own page is where it can be changed.
    return (
      <span className="inline-flex min-w-0 items-center gap-2">
        <button
          onClick={() => open()}
          disabled={busy}
          title={carried ? `Carry this conversation on, here, in ${modeWords(carried)}` : 'Carry this conversation on, here'}
          className="text-[11px] border border-accent text-accent px-1.5 rounded-sm hover:bg-accent/10 disabled:opacity-50"
        >
          {busy ? 'opening…' : 'continue'}
        </button>
        {carried && <span className="truncate text-[11px] text-fg-faint">{modeWords(carried)}</span>}
        {error && <span className="text-[11px] text-danger truncate" title={error}>failed</span>}
      </span>
    )
  }

  if (!resume.ok) {
    return (
      <span className="inline-flex items-center gap-2 text-[11px] text-fg-muted">
        <span>can’t continue here: {resume.reason}</span>
        {copyButton}
        {error && <span className="text-danger">{error}</span>}
      </span>
    )
  }

  if (detached) {
    // The button says what happens; the line under it says what the other
    // choice is and why anyone would want it, in words a reader without the
    // vocabulary ("fork", "PTY") can act on.
    return (
      <div className="flex flex-col items-center gap-2">
        <button
          onClick={() => open(false)}
          disabled={busy}
          className="rounded-sm bg-accent px-3.5 py-2 text-[13px] font-medium text-bg hover:brightness-110 disabled:opacity-50"
        >
          {busy ? 'Opening…' : 'Continue it here'}
        </button>
        {modePicker}
        <p className="max-w-[52ch] text-[12px] leading-relaxed text-fg-faint">
          Or{' '}
          <button onClick={() => open(true)} disabled={busy} className="underline hover:text-fg disabled:opacity-50">
            open a copy instead
          </button>
          : the old process is left running, and the copy carries the conversation on separately.
        </p>
        {copyButton}
        {error && <span className="text-[11px] text-danger">{error}</span>}
      </div>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={() => open()}
        disabled={busy}
        title={
          live
            ? 'Open a branch of this conversation here — the original keeps running'
            : 'Carry this conversation on, here'
        }
        className="text-[11px] border border-accent text-accent px-1.5 rounded-sm hover:bg-accent/10 disabled:opacity-50"
      >
        {busy ? 'opening…' : live ? 'branch here' : 'continue here'}
      </button>
      {modePicker}
      {copyButton}
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </span>
  )
}
