/**
 * Settings → Talks (ADR-110, .ai/27-talks.md): how you appear to the people
 * you talk with, what never leaves in a Talk, the brief every Talk's agent
 * gets, and the caps a Talk stops at. On the machine only.
 */
import { useEffect, useState } from 'react'
import { errText } from '@/lib/api'
import { talksApi, type TalkSettings } from '@/lib/talks'
import { href } from '@/lib/router'
import { useApi } from '@/lib/useApi'
import { Section } from './SettingsParts'

const FIELD = 'w-full rounded-[8px] border border-border-strong bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-accent'

export function TalksSetting() {
  const st = useApi(() => talksApi.settings(), [], { live: false })
  const [draft, setDraft] = useState<TalkSettings | null>(null)
  const [terms, setTerms] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const v = st.data
  useEffect(() => {
    if (v && !draft) {
      setDraft(v.settings)
      setTerms((v.settings.never_share ?? []).join('\n'))
    }
  }, [v, draft])
  if ((st.error as { status?: number } | undefined)?.status === 501) return null
  const d = draft ?? {}
  const set = (patch: Partial<TalkSettings>) => { setDraft({ ...d, ...patch }); setSaved(false) }
  const save = async () => {
    setError('')
    try {
      const never_share = terms.split('\n').map((t) => t.trim()).filter(Boolean)
      const next = await talksApi.saveSettings({ ...d, never_share })
      setDraft(next.settings)
      setTerms((next.settings.never_share ?? []).join('\n'))
      setSaved(true)
      st.refresh()
    } catch (e) { setError(errText(e)) }
  }
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s))
  return (
    <Section id="talks" title="Talks">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        Your agent and a person&rsquo;s agent talk for you two (<a href={href({ name: 'talks' })}>Talks</a>). Before each message leaves, Caprock takes out keys and secrets and checks it against the terms below; one that names a term waits for you to Send, Edit or Drop it.
      </p>
      {v && (
        <div className="grid gap-3">
          <label className="grid gap-1 text-[13px] text-fg">
            Your name in Talks
            <input value={d.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder="what the people you talk with see" className={`${FIELD} max-w-xs`} data-talks-name />
          </label>
          <label className="grid gap-1 text-[13px] text-fg">
            Never share
            <textarea value={terms} rows={3} onChange={(e) => { setTerms(e.target.value); setSaved(false) }} placeholder={'one per line: a client, a project, a person'} className={`${FIELD} mono`} data-talks-never />
            <span className="text-[12px] text-fg-faint">Matched anywhere in a message, in any case. The list itself is never sent.</span>
          </label>
          <label className="grid gap-1 text-[13px] text-fg">
            Brief every Talk&rsquo;s agent gets
            <textarea value={d.brief ?? ''} rows={2} onChange={(e) => set({ brief: e.target.value })} placeholder={v.defaults.brief} className={FIELD} data-talks-brief />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-[13px] text-fg">
              Messages per side
              <input type="number" min={1} max={100} value={d.max_messages ?? ''} placeholder={String(v.defaults.max_messages)} onChange={(e) => set({ max_messages: num(e.target.value) })} className={`${FIELD} w-28`} data-talks-max-messages />
            </label>
            <label className="grid gap-1 text-[13px] text-fg">
              Dollars per side
              <input type="number" min={0.1} step={0.5} value={d.max_usd ?? ''} placeholder={String(v.defaults.max_usd)} onChange={(e) => set({ max_usd: num(e.target.value) })} className={`${FIELD} w-28`} data-talks-max-usd />
            </label>
            <span className="pb-1.5 text-[12px] text-fg-faint">A Talk stops at either and asks you.</span>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg">
            <input type="checkbox" checked={d.share_cost ?? v.defaults.share_cost} onChange={(e) => set({ share_cost: e.target.checked })} className="accent-[var(--color-accent)]" />
            Tell the other side what a Talk cost you
          </label>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => void save()} className="min-h-9 rounded-[8px] bg-accent px-3 text-[13px] font-medium text-bg" data-talks-save>Save</button>
            {saved && <span role="status" className="text-[12px] text-fg-faint">Saved. The never-share list applies at once; the brief and caps to new Talks.</span>}
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}
