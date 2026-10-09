/**
 * "A star on GitHub helps others find it." — the one favour Caprock asks.
 *
 * A slim strip at the bottom of the dashboard and above the app's status
 * strip, never over content. It appears only after real use (lib/nudges.ts
 * starEligible: three days with sessions, ten sessions), never on a first run,
 * and only when no other offer holds the slot. "I starred it" thanks the
 * reader once and never asks again; × puts it away for a month. Both answers
 * are kept on the daemon, so the app and a browser tab agree.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { markAnswered, usePromptDue } from '@/lib/prompts'
import { openExternal, REPO_URL, starEligible, useNudgeSlot } from '@/lib/nudges'

export function StarStrip({ now = Date.now(), app = false }: { now?: number; app?: boolean }) {
  const hist = useApi(() => api.history('all'), [], { live: false, intervalMs: 600_000 })
  const done = !usePromptDue('star-done', now)
  const snoozed = !usePromptDue('star-dismissed', now)
  const [thanks, setThanks] = useState(false)
  const eligible = thanks || (!done && !snoozed && starEligible(hist.data?.totals))
  const mine = useNudgeSlot('star', eligible)

  useEffect(() => {
    if (!thanks) return
    const t = setTimeout(() => setThanks(false), 3000)
    return () => clearTimeout(t)
  }, [thanks])

  if (!mine) return null
  return (
    <div
      role="region"
      aria-label="Star Caprock on GitHub"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-panel-2 px-3 py-1.5 text-[12px] ${app ? '' : 'justify-center'}`}
    >
      {thanks ? (
        <span className="text-fg" role="status">Thank you!</span>
      ) : (
        <>
          <span className="text-fg-muted">Enjoying Caprock? A star on GitHub helps others find it.</span>
          <button
            type="button"
            onClick={() => openExternal(REPO_URL)}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-[12px] font-medium text-bg hover:brightness-110"
          >
            <span aria-hidden>★</span> Star on GitHub
          </button>
          <button
            type="button"
            onClick={() => { markAnswered('star-done', now); setThanks(true) }}
            className="rounded-md border border-border px-2 py-0.5 text-fg-muted hover:border-border-strong hover:text-fg"
          >
            I starred it
          </button>
          <button
            type="button"
            onClick={() => markAnswered('star-dismissed', now)}
            aria-label="Hide for a month"
            title="Hide for a month"
            className="px-1 text-fg-faint hover:text-fg-muted"
          >
            ×
          </button>
        </>
      )}
    </div>
  )
}
