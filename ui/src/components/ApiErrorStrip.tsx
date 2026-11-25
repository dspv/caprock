/**
 * The API-error line (ADR-105): one quiet line under the terminal of a
 * Claude Code session Caprock started, after its turn ended on a transient
 * API error once Claude Code's own retries were spent. It says Caprock typed
 * "continue" and which try that was, that the session went on, or that
 * Caprock gave up after its tries — the words are lib/apiError's. Hide puts
 * it away until the next change. The same shape as the limit strip under
 * it (LimitStrip), so the two read as one family.
 */
import { useState } from 'react'
import type { SessionSummary } from '@/lib/api'
import { apiErrorNotice } from '@/lib/apiError'
import { useNow } from '@/lib/useNow'
import { openSettingsAt } from './Pairing'

export function ApiErrorStrip({ session }: { session: SessionSummary }) {
  const now = useNow(60_000)
  const notice = apiErrorNotice(session, now)
  const key = `${notice?.kind}:${session.api_error?.at ?? 0}:${session.api_error?.resumed_at ?? 0}`
  const [hidden, setHidden] = useState('')
  if (!notice || hidden === key) return null
  return (
    <div role="status" aria-label="API error" data-api-error-strip={notice.kind} className="flex h-[30px] shrink-0 items-center gap-2 overflow-hidden border-t border-term-border bg-term-bg px-3 text-[12px]">
      <span className={`min-w-0 shrink truncate ${notice.kind === 'gave_up' ? 'text-danger/90' : 'text-fg-muted'}`} title={notice.text}>
        {notice.text}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <button type="button" onClick={() => openSettingsAt('api-error')} title="Settings → After an API error" className="text-fg-faint underline-offset-2 hover:text-fg hover:underline">
          Settings
        </button>
        <button type="button" onClick={() => setHidden(key)} title="Hide this line" className="h-[22px] rounded-[6px] px-1.5 text-fg-faint hover:text-fg">
          Hide
        </button>
      </span>
    </div>
  )
}
