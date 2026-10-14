/**
 * A loop alert as one card: what happened in one sentence, and three things
 * to do about it — tell the agent, open the session, dismiss.
 *
 * It replaced a row of eleven fragments and five controls ("open", "this is
 * what a cap stops", "a cap that stops this", "×", "dismiss") that the owner
 * read as "many buttons, zero meaning" (2026-10-14, translated). What he asked
 * for instead: pass a message into the same session so the agent knows,
 * marked as coming from Caprock. That is "Tell the agent": the text is shown
 * first and can be edited, then it goes through the session's own message
 * queue (ADR-053) — typed in at once when the agent is idle, otherwise held
 * until its turn ends, exactly like anything typed into the chat field.
 *
 * **Only on a session Caprock started (rule 7).** Caprock never types into a
 * process it did not start, so on someone's own terminal session the card
 * offers "Open session" in that place and says why on hover. Unknown
 * ownership counts as not owned.
 *
 * The cap is one quiet item in the dismiss menu, "Set a spending cap…": the
 * two near-identical cap links it replaced were most of the noise, and a cap
 * reaches only Caprock's own sessions anyway.
 *
 * Used on Now (components/Attention.tsx) and in the session cockpit.
 */
import { useRef, useState } from 'react'
import { api, errText, type LoopAlert } from '@/lib/api'
import { fmtAgo, fmtUSD } from '@/lib/format'
import { href } from '@/lib/router'
import { dismissLoop, loopHeadline, muteLoop, muteNoun, tellAgentMessage } from '@/lib/loopalert'
import { MenuBox, MenuItem, MenuSeparator, type MenuAt } from './RowMenu'
import { ChevronIcon, CloseIcon, EyeOffIcon } from './AppIcons'

const NOT_OWNED = "Caprock didn't start this session, so it never types into it. Open it and tell the agent yourself."

const btn = 'h-[24px] rounded-[6px] px-2.5 text-[12px] whitespace-nowrap'
const outline = `${btn} border border-border text-fg-muted hover:border-border-strong hover:text-fg`

export function LoopAlertCard({ alert, project, owned, sessionCostUSD, now, openHref, onDismiss }: {
  alert: LoopAlert
  /** The project name the sentence starts with; empty reads "This session". */
  project: string
  /** Whether Caprock started the session. Undefined is unknown: treated as not. */
  owned?: boolean
  /** What the whole session has spent — never the loop's cost (attention.ts). */
  sessionCostUSD?: number
  now: number
  /** Where "Open session" goes; absent where the card already sits in the session. */
  openHref?: string
  /** Also told when the card is dismissed or muted (Now drops it from the live list). */
  onDismiss?: () => void
}) {
  const head = loopHeadline(project, alert)
  const canTell = owned === true
  const [draft, setDraft] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const menuBtn = useRef<HTMLButtonElement>(null)

  const dismiss = () => { dismissLoop(alert); onDismiss?.() }
  const mute = () => { setMenu(null); muteLoop(alert); onDismiss?.() }

  const send = async () => {
    const text = (draft ?? '').trim()
    if (!text || sending) return
    setSending(true)
    setResult(null)
    try {
      const r = await api.queueSend(alert.session_id, text)
      setResult({ ok: true, text: r.sent ? 'Sent — the agent has it.' : 'Queued — the agent gets it when this turn ends.' })
      setDraft(null)
    } catch (e) {
      setResult({ ok: false, text: `Not sent: ${errText(e)}` })
    } finally {
      setSending(false)
    }
  }

  const ago = alert.last_ts || alert.ts
  const tax = typeof alert.tax_usd === 'number' && alert.tax_usd >= 0.01 ? alert.tax_usd : undefined
  const partial = Number.isFinite(alert.tax_priced_calls) && Number.isFinite(alert.count) && (alert.tax_priced_calls as number) < alert.count
  const open = openHref && (
    <a
      href={openHref}
      title={canTell ? 'Open the session at the first repeated call' : NOT_OWNED}
      className={`${canTell ? outline : `${btn} border border-danger/40 text-fg hover:border-danger/70`} inline-flex items-center no-underline`}
    >
      Open session
    </a>
  )

  return (
    <section aria-label="Loop alert" role="alert" className="grid gap-1.5 rounded-[var(--radius-panel)] border border-danger/45 bg-danger/[0.07] px-3 py-2.5">
      <div className="flex min-w-0 items-baseline gap-x-2">
        <p className="min-w-0 flex-1 text-[13px] leading-snug text-fg">
          <span className="mr-2 text-[11px] font-medium uppercase tracking-[0.04em] text-danger">Loop</span>
          {head.sentence}
          {head.short && (
            <> <span className="mono text-[12px] text-fg-muted" title={head.input}>({head.short})</span></>
          )}
        </p>
        {ago && <span className="num shrink-0 text-[11px] text-fg-faint">{fmtAgo(ago, now)}</span>}
      </div>

      {/* Quiet, and named for what they are: the context those calls re-read,
        * and the whole session's spend — neither is "what the loop cost". */}
      {(tax !== undefined || (sessionCostUSD ?? 0) > 0) && (
        <p className="text-[11px] text-fg-faint">
          {tax !== undefined && (
            <span title="what these repeated calls paid to re-read the conversation">
              {partial ? 'at least ' : ''}<span className="num">{fmtUSD(tax)}</span> re-reading context
            </span>
          )}
          {tax !== undefined && (sessionCostUSD ?? 0) > 0 && <span> · </span>}
          {(sessionCostUSD ?? 0) > 0 && (
            <span title="what this session has spent in total — not what the loop cost">
              session total <span className="num">{fmtUSD(sessionCostUSD!)}</span>
            </span>
          )}
        </p>
      )}

      {draft !== null ? (
        <div className="grid gap-1.5">
          <label className="text-[11px] text-fg-muted" htmlFor={`tell-${alert.session_id}`}>
            Goes into this session's queue, marked as from Caprock — the agent reads it at its next turn.
          </label>
          <textarea
            id={`tell-${alert.session_id}`}
            aria-label="Message to the agent"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() }
              if (e.key === 'Escape') { e.preventDefault(); setDraft(null) }
            }}
            rows={3}
            className="w-full resize-y rounded-[6px] border border-border bg-panel px-2 py-1.5 text-[12px] leading-snug text-fg focus:border-border-strong focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              autoFocus
              disabled={sending || !draft.trim()}
              onClick={() => void send()}
              className={`${btn} bg-accent font-medium text-bg hover:brightness-110 disabled:opacity-60`}
            >
              {sending ? 'Sending…' : 'Send to the agent'}
            </button>
            <button type="button" onClick={() => setDraft(null)} className={outline}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {canTell && (
            <button
              type="button"
              onClick={() => { setResult(null); setDraft(tellAgentMessage(alert)) }}
              title="Show the message first; you can edit it before it goes"
              className={`${btn} bg-accent font-medium text-bg hover:brightness-110`}
            >
              Tell the agent
            </button>
          )}
          {open}
          {/* Inside the session there is nowhere to open: say why there is
            * no "Tell the agent" instead of leaving a gap where it would be. */}
          {!canTell && !openHref && (
            <span className="text-[11.5px] text-fg-muted">Caprock didn't start this session, so it never types into it — tell the agent in your own terminal.</span>
          )}
          <span className="ml-auto inline-flex items-stretch">
            <button
              type="button"
              onClick={dismiss}
              title="Put this away; it comes back if the loop starts again"
              className={`${btn} inline-flex items-center gap-1 rounded-r-none border border-border text-fg-muted hover:border-border-strong hover:text-fg`}
            >
              <CloseIcon size={12} /> Dismiss
            </button>
            <button
              ref={menuBtn}
              type="button"
              aria-label="More ways to dismiss"
              aria-haspopup="menu"
              aria-expanded={menu !== null}
              onClick={() => {
                const r = menuBtn.current?.getBoundingClientRect()
                setMenu(menu ? null : { x: (r?.right ?? 0) - 380, y: (r?.bottom ?? 0) + 4 })
              }}
              className={`${btn} -ml-px rounded-l-none border border-border px-1.5 text-fg-muted hover:border-border-strong hover:text-fg`}
            >
              <span className="inline-block rotate-90"><ChevronIcon size={12} /></span>
            </button>
          </span>
        </div>
      )}
      {result && (
        <p role="status" className={`text-[11.5px] ${result.ok ? 'text-ok' : 'text-danger'}`}>{result.text}</p>
      )}

      {menu && (
        <MenuBox at={menu} label="Dismiss options" width={380} onClose={() => setMenu(null)}>
          <MenuItem icon={<CloseIcon size={14} />} label="Dismiss" onClick={() => { setMenu(null); dismiss() }} />
          <MenuItem icon={<EyeOffIcon size={14} />} label={`Don't warn about ${muteNoun(alert.tool)} again in this session`} onClick={mute} />
          <MenuSeparator />
          <MenuItem
            icon={<span className="inline-block w-[14px]" />}
            label="Set a spending cap…"
            onClick={() => { setMenu(null); window.location.hash = href({ name: 'cost', section: 'cap' }) }}
          />
        </MenuBox>
      )}
    </section>
  )
}
