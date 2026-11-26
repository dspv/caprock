/**
 * A session that ended in its first seconds, said (#1086; lib/startwatch):
 * "Claude Code on Windows PC exited at once (code 0) · It ended 8 s after it
 * started…", the last line it printed, what that usually means
 * (lib/earlyexit) and **Open**, which goes to the session there. It stays
 * until it is closed: a start that did not happen is not news that fades.
 */
import { useEffect, useState } from 'react'
import { earlyExitHeadline, earlyExitHint, earlyExitWhen } from '@/lib/earlyexit'
import { machineSessionRoute } from '@/lib/machines'
import { onStartExit, type StartExit } from '@/lib/startwatch'
import { CloseIcon } from './AppIcons'
import { agentName } from './Projects'

/** The last non-empty line of what it printed, or ''. */
export function lastLine(tail: string): string {
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

export function StartExitToast() {
  const [ended, setEnded] = useState<StartExit | null>(null)
  useEffect(() => onStartExit(setEnded), [])
  if (!ended) return null
  const { report, machine, name, sessionId } = ended
  const who = `${agentName(report.agent ?? 'claude')}${machine ? ` on ${name}` : ''}`
  const hint = earlyExitHint(report.tail)
  const line = lastLine(report.tail)
  return (
    <div role="alert" data-start-exit={sessionId} className="app-fade-in pointer-events-none fixed inset-x-0 bottom-10 z-50 flex justify-center px-4">
      <div className="pointer-events-auto grid w-full max-w-[620px] gap-1 rounded-[10px] border border-danger/50 bg-panel px-4 py-2.5 text-[12.5px] text-fg shadow-[0_16px_40px_-16px_rgba(0,0,0,0.5)]">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 font-medium" data-start-exit-headline>{earlyExitHeadline(who, report.code)}</p>
          <button type="button" aria-label="Close" onClick={() => setEnded(null)} className="-mr-1 shrink-0 rounded p-0.5 text-fg-muted hover:text-fg">
            <CloseIcon />
          </button>
        </div>
        <p className="text-fg-muted">{earlyExitWhen(report.ran_ms)}{line ? ' Its last line:' : ' It printed nothing.'}</p>
        {line && <p className="mono truncate rounded-[4px] bg-panel-2 px-2 py-1 text-[12px]" title={report.tail} data-start-exit-line>{line}</p>}
        {hint && <p className="leading-snug" data-start-exit-hint>{hint}</p>}
        {machine && (
          <div>
            <a href={machineSessionRoute(machine, sessionId)} onClick={() => setEnded(null)} className="text-accent underline-offset-2 hover:underline">Open the session</a>
          </div>
        )}
      </div>
    </div>
  )
}
