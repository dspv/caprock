/**
 * Second Brain before there is one (#/brain, ADR-063): one picture, one
 * line, one button. The owner, 2026-10-15 (translated): "totally unclear
 * what to do. It should be just one click and off we go".
 *
 * The agents this user runs feeding the brain (BrainHero), *Free*, the
 * headline, the line naming those agents, and *Start building*. Under the
 * button one short line says what happens — whose Claude, what, how much,
 * and that nothing goes to Caprock — and *Details* holds the rest: the
 * model, that the prose goes to Anthropic under the user's own login, the
 * cap and where to turn it off. That line and Details are the disclosure
 * rule 4 asks for, both on screen before anything runs; the click is the
 * consent, the turn-on and the 30-day backfill in one (lib/brain
 * startBuilding).
 *
 * Without claude there is no button, only why and *Check again*. A paired
 * device cannot turn it on (every write is the machine's), and says so.
 */
import { useState } from 'react'
import { errText, type BrainAutoStatus } from '@/lib/api'
import { startBuilding, startLine, tokensShort } from '@/lib/brain'
import { keys } from '@/lib/appkeys'
import { isAppMode } from '@/lib/appmode'
import { agentsLine, BrainHero, FreePill, useAgentsUsed } from '@/components/BrainAgents'

export const START_HEADLINE = 'Give your agents a memory'

export function BrainStart({ auto, owner, onStarted, onAddNote }: {
  auto?: BrainAutoStatus
  owner: boolean
  onStarted: () => void
  onAddNote: () => void
}) {
  const agents = useAgentsUsed()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const start = () => {
    setErr('')
    setBusy(true)
    startBuilding().then(
      () => { setBusy(false); onStarted() },
      (e: unknown) => { setBusy(false); setErr(errText(e)); onStarted() },
    )
  }
  const canStart = owner && !!auto?.claude_found
  return (
    <section className="mx-auto grid w-full max-w-[600px] justify-items-center gap-3 pb-10 pt-4 text-center" data-brain-start>
      <BrainHero agents={agents} className="h-auto w-[540px] max-w-full" />
      <FreePill className="mt-1 h-[24px] px-3 text-[13px]" />
      <h2 className="text-[30px] font-semibold leading-tight tracking-[-0.02em] text-fg text-balance">{START_HEADLINE}</h2>
      <p className="-mt-1 text-[15px] leading-snug text-fg-muted" data-brain-agents-line>{agentsLine(agents)}</p>

      {!owner ? (
        <p className="mt-2 text-[14px] text-fg">Start it on the computer Caprock runs on.</p>
      ) : !auto ? (
        <p className="mt-2 text-[14px] text-fg">Building it automatically is not available in this build.</p>
      ) : !auto.claude_found ? (
        <div className="mt-2 grid justify-items-center gap-2" data-brain-no-claude>
          <p className="text-[14px] text-fg">Claude Code was not found on this computer. Install it, then:</p>
          <button type="button" onClick={onStarted} className="rounded-[8px] border border-border-strong px-4 py-2 text-[14px] text-fg hover:border-accent hover:text-accent">
            Check again
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={start}
          className="mt-2 rounded-[10px] bg-accent px-7 py-3 text-[16px] font-semibold text-panel shadow-[0_6px_24px_-8px_var(--color-accent)] hover:bg-accent-strong disabled:opacity-60"
        >
          {busy ? 'Starting…' : 'Start building'}
        </button>
      )}

      {canStart && auto && (
        <>
          <p className="max-w-[480px] text-[13px] leading-relaxed text-fg-muted" data-brain-start-line>{startLine(auto.daily_tokens)}</p>
          <details className="w-full max-w-[420px] text-left text-[13.5px] leading-relaxed text-fg" data-brain-start-details>
            <summary className="cursor-pointer select-none text-center text-[12.5px] text-fg-muted hover:text-fg">Details</summary>
            <ul className="mt-2 grid list-disc gap-1 pl-5">
              <li>Your own <span className="mono">claude</span> ({auto.model}) reads each session’s prompts and answers</li>
              <li>They go to Anthropic under your login, as the session did</li>
              <li>Up to {tokensShort(auto.daily_tokens)} tokens a day · off any time in Settings</li>
            </ul>
          </details>
        </>
      )}
      {err && <p role="alert" className="text-[13px] text-danger">{err}</p>}

      {owner && (
        <button type="button" onClick={onAddNote} title={isAppMode() ? `Add a note (${keys('⇧⌘H')})` : undefined}
          className="mt-3 text-[12.5px] text-fg-muted hover:text-fg hover:underline" data-brain-add-note>
          Add a note
        </button>
      )}
    </section>
  )
}
