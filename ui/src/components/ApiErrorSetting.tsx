/**
 * Settings → After an API error (ADR-105): whether Caprock types "continue"
 * into a Claude Code session it started whose turn ended on a transient API
 * error (overloaded, a 5xx, a network failure) once Claude Code's own
 * retries were spent. On by default. Placed under When a limit is reached,
 * the other thing that stops a session by itself.
 */
import { useState } from 'react'
import { api, errText, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Section } from './SettingsParts'

export function ApiErrorSetting() {
  const st = useApi(() => api.settings(), [], { live: false })
  const [draft, setDraft] = useState<boolean | undefined>(undefined)
  const [error, setError] = useState('')
  const on = draft ?? st.data?.resume_after_api_error ?? true
  const save = async (v: boolean) => {
    setDraft(v)
    setError('')
    try {
      await api.saveSettings({ resume_after_api_error: v } as Settings)
      st.refresh?.()
    } catch (e) {
      setError(errText(e))
      setDraft(undefined)
    }
  }
  return (
    <Section id="api-error" title="After an API error">
      <p className="text-[12px] leading-relaxed text-fg-muted">
        When Claude Code gives up on an overloaded or failing API call in a session Caprock started, Caprock types &ldquo;continue&rdquo; for it: a minute later, then five, then fifteen, three tries at most. It stops as soon as the session goes on or you type. A usage limit, a sign-in or a request that is too long is never retried.
      </p>
      {st.data && (
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-fg">
          <input type="checkbox" checked={on} onChange={(e) => void save(e.target.checked)} className="accent-[var(--color-accent)]" />
          Resume after API errors
          <span className="text-[12px] text-fg-faint">a line under the terminal says when it did</span>
        </label>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </Section>
  )
}
