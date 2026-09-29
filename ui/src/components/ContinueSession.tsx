import { useState } from 'react'
import { api, ApiError, type ResumeInfo } from '@/lib/api'
import { navigate } from '@/lib/router'

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
 */
export function ContinueSession({
  sessionID,
  cwd,
  live,
  resume,
  compact = false,
}: {
  sessionID: string
  cwd: string
  /** Whether the session is still running: decides continue vs branch. */
  live: boolean
  /** The server's answer to "can this be resumed here", with the reason when not. */
  resume: ResumeInfo
  /** On a card: one word, the reason on hover, no copy command. */
  compact?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  const command = resume.command ?? ''

  async function open() {
    setBusy(true)
    setError('')
    try {
      const res = await api.spawn({ cwd, resume: sessionID, fork: live })
      navigate({ name: 'session', id: res.session_id, tab: 'terminal' })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
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

  // Not a disabled button: a greyed-out "continue" says only that something
  // is wrong. The reason is the useful part, so it is what is shown.
  if (compact) {
    if (!resume.ok) {
      return <span className="text-[11px] text-fg-faint truncate" title={resume.reason}>can’t continue</span>
    }
    return (
      <span className="inline-flex items-center gap-2">
        <button
          onClick={open}
          disabled={busy}
          title="Carry this conversation on, here"
          className="text-[11px] border border-accent text-accent px-1.5 rounded-sm hover:bg-accent/10 disabled:opacity-50"
        >
          {busy ? 'opening…' : 'continue'}
        </button>
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

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={open}
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
      {copyButton}
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </span>
  )
}
