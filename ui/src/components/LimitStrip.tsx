/**
 * The limit strip (ADR-090, V1): one quiet line under the terminal of a
 * Claude Code session Caprock started that stopped at its plan's usage
 * limit. It says which window and when it reopens, then offers each place
 * the session can go on — another Claude sign-in, DeepSeek or Kimi on the
 * user's key, Codex — as a small chip with its character, and Wait, which
 * only hides the strip for this limit. A click continues it there; the tab
 * follows the new session (AppShell, lib/continueOn's announceContinued).
 *
 * The owner picked it over a card (2026-11-03): unobtrusive, one line. On a
 * narrow pane the limit text gives way first; the chips keep their words.
 */
import { useState } from 'react'
import { api, errText, type SessionSummary } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { useNow } from '@/lib/useNow'
import { announceContinued, choiceTitle, continueChoices, limitLine, ownTarget, waitOut, waitedOut, type ContinueChoice } from '@/lib/continueOn'
import { AgentCharacter } from './Characters'
import { useSubscriptionsChanged } from './SubscriptionPicker'
import { openSettingsAt } from './Pairing'

export function LimitStrip({ session }: { session: SessionSummary }) {
  const hit = session.limit_hit
  const [, setWaited] = useState(0)
  if (!hit || waitedOut(session.session_id, hit)) return null
  return <StripBody key={hit.at} session={session} onWait={() => { waitOut(session.session_id, hit); setWaited((n) => n + 1) }} />
}

function StripBody({ session, onWait }: { session: SessionSummary; onWait: () => void }) {
  const hit = session.limit_hit!
  const subs = useApi(() => api.subscriptions(), [], { live: false, share: 'subscriptions' })
  // Settings → When a limit is reached: Wait shows the line, the targets on a click.
  const st = useApi(() => api.settings(), [], { live: false })
  const [opened, setOpened] = useState(false)
  const quiet = st.data?.limit_action === 'wait' && !opened
  useSubscriptionsChanged(subs.refresh)
  const now = useNow(30_000)
  const line = limitLine(hit, now)
  const choices = continueChoices(ownTarget(session), subs.data)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const go = async (c: ContinueChoice) => {
    setBusy(c.target)
    setError('')
    try {
      announceContinued(await api.continueOn(session.session_id, c.target))
    } catch (e) {
      setError(errText(e))
      setBusy('')
    }
  }
  const text = `${line.name}${line.back ? ` · back at ${line.back}` : ''}${line.until ? ` (${line.until})` : ''}`
  return (
    <div role="status" aria-label="Usage limit" data-limit-strip className="flex h-[30px] shrink-0 items-center gap-2 overflow-hidden border-t border-term-border bg-term-bg px-3 text-[12px]">
      <span className="min-w-0 shrink truncate text-accent/90" title={text}>
        {line.name}
        {line.back && <> · back at <span className="text-accent">{line.back}</span></>}
        {line.until && <span className="text-fg-faint"> ({line.until})</span>}
      </span>
      {error && <span role="alert" className="min-w-0 shrink truncate text-danger" title={error}>{error}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {subs.data && choices.length === 0 && (
          <button type="button" onClick={() => openSettingsAt('subscriptions')} className="text-fg-faint underline-offset-2 hover:text-fg hover:underline">
            Add DeepSeek or Kimi key
          </button>
        )}
        {quiet && choices.length > 0 && (
          <button type="button" onClick={() => setOpened(true)} className="text-fg-faint underline-offset-2 hover:text-fg hover:underline">Continue elsewhere…</button>
        )}
        {!quiet && choices.length > 0 && <span className="text-fg-faint">Continue on</span>}
        {!quiet && choices.map((c) => (
          <button
            key={c.target}
            type="button"
            title={choiceTitle(c)}
            disabled={!!busy}
            data-target={c.target}
            onClick={() => void go(c)}
            className="flex h-[22px] items-center gap-1 rounded-[6px] border border-border px-1.5 text-fg-muted hover:border-border-strong hover:text-fg disabled:opacity-50"
          >
            <AgentCharacter who={c.who} face={c.face} size={15} />
            <span>{busy === c.target ? `${c.label}…` : c.label}</span>
          </button>
        ))}
        {!quiet && (
          <button type="button" onClick={onWait} title="Hide this until the next limit" className="h-[22px] rounded-[6px] px-1.5 text-fg-faint hover:text-fg">
            Wait
          </button>
        )}
      </span>
    </div>
  )
}
