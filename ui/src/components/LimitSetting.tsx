/**
 * Settings → When a limit is reached (ADR-090, V3): what happens when a
 * Claude Code session Caprock started stops at its plan's usage limit.
 *
 * - Ask me (the default): the line under the terminal offers where to go on.
 * - Continue automatically on: the first target of an ordered list that can
 *   take it, moved by the daemon; reordered with the arrow buttons, and only
 *   the ones set up here are enabled. Back on Claude after the reset brings
 *   a moved session back once its own window reopens.
 * - Wait for the reset: the line under the terminal says when, and offers
 *   the targets only on a click.
 *
 * Self-contained: one section with its own fetching, placed beside
 * Subscriptions, where the keys and sign-ins it lists are set up.
 */
import { useState } from 'react'
import { api, errText, type LimitAction, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { continueChoices, fallbackRows, targetName } from '@/lib/continueOn'
import { Section } from './SettingsParts'
import { AgentCharacter } from './Characters'
import { useSubscriptionsChanged } from './SubscriptionPicker'

const ACTIONS: { value: LimitAction; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask me', hint: 'A line under the terminal offers where to continue.' },
  { value: 'auto', label: 'Continue automatically on', hint: 'The first one below that can take it; a note says where it went, with Undo.' },
  { value: 'wait', label: 'Wait for the reset', hint: 'The line under the terminal says when it reopens.' },
]

export function LimitSetting() {
  const st = useApi(() => api.settings(), [], { live: false })
  const subs = useApi(() => api.subscriptions(), [], { live: false, share: 'subscriptions' })
  useSubscriptionsChanged(subs.refresh)
  const [draft, setDraft] = useState<Partial<Settings>>({})
  const [error, setError] = useState('')
  const cur = { ...st.data, ...draft }
  const action: LimitAction = cur.limit_action ?? 'ask'
  const available = continueChoices('', subs.data)
  const rows = fallbackRows(cur.limit_fallbacks ?? [], available)
  const save = async (patch: Partial<Settings>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setError('')
    try {
      await api.saveSettings(patch as Settings)
      st.refresh?.()
    } catch (e) {
      setError(errText(e))
      setDraft((d) => { const next = { ...d }; for (const k of Object.keys(patch)) delete next[k as keyof Settings]; return next })
    }
  }
  const order = rows.map((r) => r.target)
  const pick = (a: LimitAction) => {
    // Automatic with no order saved yet: the order shown is the order used.
    void save(a === 'auto' && (cur.limit_fallbacks ?? []).length === 0 ? { limit_action: a, limit_fallbacks: order } : { limit_action: a })
  }
  const move = (i: number, by: -1 | 1) => {
    const next = order.slice()
    const j = i + by
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    void save({ limit_fallbacks: next })
  }
  return (
    <Section id="limit-reached" title="When a limit is reached">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        When a Claude Code session Caprock started stops at its plan&rsquo;s 5-hour or weekly limit. Another Claude sign-in, DeepSeek or Kimi carry on the same conversation; Codex starts a new session from a summary of it.
      </p>
      {st.data && (
        <div role="radiogroup" aria-label="When a limit is reached" className="grid gap-1.5">
          {ACTIONS.map((a) => (
            <div key={a.value} className="grid gap-1">
              <label className="flex cursor-pointer items-baseline gap-2 text-[13px] text-fg">
                <input type="radio" name="limit-action" value={a.value} checked={action === a.value} onChange={() => pick(a.value)} className="translate-y-[1px] accent-[var(--color-accent)]" />
                <span>{a.label}</span>
                <span className="text-[12px] text-fg-faint">{a.hint}</span>
              </label>
              {a.value === 'auto' && action === 'auto' && (
                <div className="ml-6 grid gap-1.5">
                  {rows.length === 0 && <p data-keep className="text-[12px] text-fg-muted">Nothing to continue on yet: add a sign-in, a DeepSeek or Kimi key under Subscriptions, or sign in to Codex.</p>}
                  {rows.length > 0 && (
                    <ol aria-label="Continue on, in this order" className="grid max-w-[520px] gap-1">
                      {rows.map((r, i) => {
                        const c = r.choice
                        const name = c?.label ?? targetName(r.target, subs.data)
                        return (
                          <li key={r.target} data-target={r.target} data-off={c ? undefined : ''} className={`flex h-[30px] items-center gap-2 rounded-[7px] border border-border px-2 text-[12.5px] ${c ? 'text-fg' : 'text-fg-faint'}`}>
                            <span className="mono w-4 text-right text-[11.5px] text-accent">{i + 1}</span>
                            {c ? <AgentCharacter who={c.who} face={c.face} size={16} /> : <span className="w-4" />}
                            <span className="min-w-0 truncate">{name}</span>
                            <span className="min-w-0 truncate text-[11.5px] text-fg-faint">{c ? (c.summary ? 'new session from a summary' : 'same session') : 'not set up — skipped'}</span>
                            <span className="ml-auto flex shrink-0 gap-0.5">
                              <button type="button" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)} className="h-[22px] w-[22px] rounded-[5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg disabled:opacity-30">↑</button>
                              <button type="button" aria-label={`Move ${name} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)} className="h-[22px] w-[22px] rounded-[5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg disabled:opacity-30">↓</button>
                            </span>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                  <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-fg">
                    <input type="checkbox" checked={!!cur.limit_return_after_reset} onChange={(e) => void save({ limit_return_after_reset: e.target.checked })} className="accent-[var(--color-accent)]" />
                    Back on Claude after the reset
                    <span className="text-[12px] text-fg-faint">once its own window reopens and it is not mid-turn</span>
                  </label>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}
