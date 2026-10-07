/**
 * The one-time bypass consent (ADR-041, owner, 2026-10-07).
 *
 * Claude Code shows a warning the first time a session runs with
 * --dangerously-skip-permissions, and its default answer is "No, exit": a
 * new user who presses Enter is dropped from the session into a shell, and a
 * session started from a phone sits on a screen nobody sees. Bypass is
 * Caprock's default, so the warning is shown here instead, in the dialog the
 * user is already in, and the start button says what pressing it means. On
 * "Accept and start" the daemon writes the key Claude Code itself writes on
 * "Yes, I accept". Nothing is skipped silently.
 */
import { useState } from 'react'
import { api, ApiError, isPairedDevice } from '@/lib/api'
import { useApi } from '@/lib/useApi'

/** Whether this start needs the consent first, and how to give it. */
export function useBypassConsent(agent: string, mode: string) {
  const status = useApi(() => api.status(), [], { live: false })
  // The daemon refused a start the status said was fine (accepted elsewhere
  // and then removed): trust the refusal.
  const [refused, setRefused] = useState(false)
  // A paired device cannot give it: the consent is given at the machine.
  const remote = isPairedDevice()
  const unaccepted = refused || status.data?.claude_bypass_accepted === false
  const needed = !remote && agent === 'claude' && mode === 'bypassPermissions' && unaccepted
  return {
    needed,
    accept: () => api.acceptBypass(),
    /** True when the error was the daemon asking for the consent; the dialog
     *  then shows it rather than the message. */
    noteRefusal: (e: unknown) => {
      const asked = e instanceof ApiError && e.status === 409 && (e.body as { code?: string } | undefined)?.code === 'bypass_consent'
      if (asked && !remote) setRefused(true)
      return asked && !remote
    },
  }
}

/** Claude Code's warning, in Caprock's words, above the start button. */
export function BypassConsentNote() {
  return (
    <div role="note" aria-label="Bypass consent" className="grid gap-1 rounded-sm border border-danger/50 bg-danger/10 px-3 py-2 text-[12.5px] leading-relaxed text-fg">
      <p className="font-medium">First bypass session on this computer</p>
      <p className="text-fg-muted">
        In bypass, Claude Code does not ask before running commands or editing files. Use it where a mistake is easy to undo
        — a repository you can reset, not a machine with secrets you cannot lose. You accept responsibility for what the agent
        does. Claude Code asks this once; <span className="text-fg">Accept and start</span> answers it for good on this computer.
      </p>
    </div>
  )
}
