/**
 * Jarvis's brain (.ai/04-ui.md § Jarvis, *The brain*): which of the user's
 * own agent sign-ins reads plain speech and answers routine agent questions.
 * Never an API key of Caprock's: Claude Code or Codex on this computer, on a
 * sign-in from Settings → Subscriptions, saved as `jarvis_brain` (PUT
 * /v1/settings; 03-contracts.md § Jarvis).
 *
 * Off until the user picks it once (rule 4, ADR-047): the first-use card says
 * what is sent where before anything is, with Claude preselected; the status
 * in the top line and Settings → Jarvis open the same chooser.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, errText, type JarvisBrain, type JarvisBrainSetting, type Settings, type Subscription } from '@/lib/api'
import { brainWord } from '@/lib/jarvis'
import { optionText, useSubscriptionList } from './SubscriptionPicker'
import { openSettingsAt } from './Pairing'
import { Section } from './SettingsParts'

/** What is sent, and where: said on the card and in the chooser, before anything is. */
export const BRAIN_SENDS =
  'Your message, the Needs you list and your agents’ titles go to the subscription you pick, through its own program on this computer (Claude Code or Codex). Nothing goes to Caprock.'

/** What auto-answer may and may not do. */
export const AUTO_ANSWER_NOTE =
  'Routine agent questions only, in sessions Caprock started — never a permission, a plan, or anything that pushes, deploys, publishes, deletes, pays or sends messages. Each answer is listed under Handled for you.'

/** One click on the first-use card: Claude Code on its own sign-in, routine questions answered. */
export const CLAUDE_DEFAULT: JarvisBrainSetting = { agent: 'claude', auto_answer: 'routine' }

/** Saves the choice; the digest's `brain` (and the live frame) then says how it went. */
export async function saveBrain(b: JarvisBrainSetting): Promise<void> {
  await api.saveSettings({ jarvis_brain: b } as Partial<Settings> as Settings)
}

/** The setting the chooser starts from: the digest's brain, else Claude. */
export function settingOf(b: JarvisBrain | undefined): JarvisBrainSetting {
  if (!b || b.state === 'unchosen') return CLAUDE_DEFAULT
  if (b.state === 'off' || !b.agent) return { agent: 'off', auto_answer: b.auto_answer ?? 'routine' }
  return { agent: b.agent, sub: b.sub, auto_answer: b.auto_answer }
}

/** The first-use card: plain words on what is sent where, Claude one click away. */
export function BrainFirstUse({ onChoose, onNotNow, onSaved }: { onChoose: () => void; onNotNow: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const use = async () => {
    setBusy(true); setError('')
    try { await saveBrain(CLAUDE_DEFAULT); onSaved() } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  return (
    <section data-jarvis-brain-card aria-label="Let Jarvis understand plain words"
      className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-[var(--radius-panel)] border border-accent/50 bg-accent/5 px-3 py-2.5">
      <h2 className="text-[14px] font-semibold text-fg">Let Jarvis understand plain words</h2>
      <p className="text-[13px] leading-snug text-fg">
        Say what you need without <span className="mono">@project</span>, and let Jarvis answer routine agent questions for you. It runs on your own Claude subscription, through Claude Code on this computer.
      </p>
      <p className="text-[12px] leading-snug text-fg-muted"><span className="font-medium text-fg">What is sent where:</span> {BRAIN_SENDS} {AUTO_ANSWER_NOTE}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void use()}
          className="min-h-[32px] rounded-[7px] bg-accent px-3 text-[13px] font-medium text-bg hover:brightness-110 disabled:opacity-50">Use my Claude subscription</button>
        <button type="button" disabled={busy} onClick={onChoose}
          className="min-h-[32px] rounded-[7px] border border-border-strong px-3 text-[13px] text-fg hover:bg-panel-2">Choose…</button>
        <button type="button" disabled={busy} onClick={onNotNow} title="Hide this for a week; Settings → Jarvis has it"
          className="min-h-[32px] px-2 text-[13px] text-fg-muted hover:text-fg">Not now</button>
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </section>
  )
}

/** The brain's state in the top line; a click opens the chooser. Signed out also links to Subscriptions. */
export function BrainStatus({ brain, onOpen }: { brain: JarvisBrain | undefined; onOpen: () => void }) {
  const w = brainWord(brain)
  if (!w) return null
  const tone = w.tone === 'ok' ? 'text-ok' : w.tone === 'warn' ? 'text-warn' : 'text-fg-muted'
  return (
    <span data-jarvis-brain={brain?.state} className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px]">
      <button type="button" onClick={onOpen} title={brain?.note || 'Jarvis’s brain: which subscription reads what you say'}
        className={`inline-flex h-[24px] min-w-0 items-center gap-1.5 rounded-full border border-border px-2 hover:bg-panel-2 ${tone}`}>
        <span aria-hidden className={`h-[6px] w-[6px] shrink-0 rounded-full ${w.tone === 'ok' ? 'bg-ok' : w.tone === 'warn' ? 'bg-warn' : 'bg-fg-faint'}`} />
        <span className="truncate">{w.text}</span>
      </button>
      {brain?.state === 'signed-out' && (
        <button type="button" onClick={() => openSettingsAt('subscriptions')} className="shrink-0 text-accent hover:underline">fix</button>
      )}
    </span>
  )
}

/** The sign-ins the brain can run on: an agent's own, not a model provider on an API key. */
function signIns(all: readonly Subscription[], agent: 'claude' | 'codex'): Subscription[] {
  return all.filter((s) => s.agent === agent && !s.provider)
}

/**
 * The chooser: agent, sign-in, auto-answer. In Jarvis it opens under the top
 * line; in Settings it is the section's body (`onClose` absent).
 */
export function BrainChooser({ current, onSaved, onClose }: { current: JarvisBrainSetting; onSaved: (b: JarvisBrainSetting) => void; onClose?: () => void }) {
  const [draft, setDraft] = useState<JarvisBrainSetting>(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const subs = useSubscriptionList()
  const list = useMemo(() => (draft.agent === 'off' ? [] : signIns(subs.all, draft.agent)), [subs.all, draft.agent])
  const sub = list.find((s) => s.id === (draft.sub ?? 'default')) ?? list[0]
  const save = async () => {
    setBusy(true); setError(''); setSaved(false)
    const next: JarvisBrainSetting = draft.agent === 'off' ? { agent: 'off', auto_answer: draft.auto_answer }
      : { agent: draft.agent, auto_answer: draft.auto_answer, ...(sub && sub.id !== 'default' ? { sub: sub.id } : {}) }
    try { await saveBrain(next); setSaved(true); onSaved(next) } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  const agentBtn = (a: JarvisBrainSetting['agent'], label: string) => (
    <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-fg">
      <input type="radio" name="jarvis-brain-agent" checked={draft.agent === a} onChange={() => { setDraft((d) => ({ ...d, agent: a, sub: undefined })); setSaved(false) }}
        className="accent-[var(--color-accent)]" />
      {label}
    </label>
  )
  return (
    <div data-jarvis-brain-chooser className="grid grid-cols-[minmax(0,1fr)] gap-2.5 [overflow-wrap:anywhere]">
      <p className="text-[12px] leading-snug text-fg-muted">{BRAIN_SENDS}</p>
      <div role="radiogroup" aria-label="Jarvis runs on" className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {agentBtn('claude', 'Claude Code')}
        {agentBtn('codex', 'Codex')}
        {agentBtn('off', 'Off — @project only')}
      </div>
      {draft.agent !== 'off' && (
        <>
          {list.length > 1 && (
            <label className="grid min-w-0 max-w-[420px] gap-1">
              <span className="text-[11.5px] text-fg-muted">Sign-in</span>
              <select value={sub?.id ?? 'default'} onChange={(e) => { setDraft((d) => ({ ...d, sub: e.target.value })); setSaved(false) }}
                className="h-[30px] min-w-0 rounded-[7px] border border-border bg-bg px-2 text-[13px] text-fg">
                {list.map((s) => <option key={s.id} value={s.id}>{optionText(s)}</option>)}
              </select>
            </label>
          )}
          {subs.loaded && sub && !sub.signed_in && (
            <p className="text-[12px] text-warn">
              {sub.label} is not signed in.{' '}
              <button type="button" onClick={() => openSettingsAt('subscriptions')} className="text-accent hover:underline">Sign in under Subscriptions</button>
            </p>
          )}
          {subs.loaded && list.length === 0 && (
            <p className="text-[12px] text-warn">{draft.agent === 'codex' ? 'Codex' : 'Claude Code'} is not set up on this computer yet.</p>
          )}
          <label className="flex cursor-pointer items-start gap-2 text-[13px] text-fg">
            <input type="checkbox" checked={draft.auto_answer === 'routine'} onChange={(e) => { setDraft((d) => ({ ...d, auto_answer: e.target.checked ? 'routine' : 'off' })); setSaved(false) }}
              className="mt-[3px] accent-[var(--color-accent)]" />
            <span className="grid gap-0.5">
              <span>Answer routine agent questions for me</span>
              <span className="text-[12px] text-fg-muted">{AUTO_ANSWER_NOTE}</span>
            </span>
          </label>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void save()}
          className="min-h-[30px] rounded-[7px] bg-accent px-3 text-[13px] font-medium text-bg hover:brightness-110 disabled:opacity-50">Save</button>
        {onClose && <button type="button" onClick={onClose} className="min-h-[30px] px-2 text-[13px] text-fg-muted hover:text-fg">Close</button>}
        {saved && <span role="status" className="text-[12px] text-ok">Saved.</span>}
      </div>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}

/** Settings → Jarvis: the same chooser, beside When a limit is reached. */
export function JarvisBrainSection() {
  const [st, setSt] = useState<{ loaded: boolean; value?: JarvisBrainSetting }>({ loaded: false })
  useEffect(() => {
    let alive = true
    api.settings().then((s) => { if (alive) setSt({ loaded: true, value: s.jarvis_brain }) }, () => { if (alive) setSt({ loaded: true }) })
    return () => { alive = false }
  }, [])
  return (
    <Section id="jarvis" title="Jarvis">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        Jarvis understands plain words — “run the tests in caprock and tell me if anything fails” — on your own agent subscription, never on a key of Caprock’s. Off, it routes <span className="mono">@project</span> messages by rule.
        {st.loaded && !st.value && ' Not chosen yet: nothing is sent until you save.'}
      </p>
      {st.loaded && <BrainChooser current={st.value ?? CLAUDE_DEFAULT} onSaved={(v) => setSt({ loaded: true, value: v })} />}
    </Section>
  )
}
