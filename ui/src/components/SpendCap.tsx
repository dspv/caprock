/**
 * The daily spend cap: one number, and what happens when the day crosses it.
 *
 * This is the first thing Caprock does rather than shows. Everything else is
 * observation — you look and you learn something. A cap acts while you are
 * asleep, which is exactly when a runaway loop does its damage.
 *
 * Three rules the interface has to carry, because each one is a promise:
 *
 *  - **Only sessions Caprock started.** A session from your own terminal is
 *    watched and never signalled, however much it costs. That is rule 7, and
 *    it is the reason anyone lets this daemon near their machine — so it is
 *    stated on the panel, not buried in documentation.
 *  - **Paused, not killed.** The conversation, the directory and the context
 *    survive; resume and the session carries on. Killing would throw away work
 *    already paid for, which is a strange thing for a tool that exists to stop
 *    waste.
 *  - **The suggestion comes from your own history.** A blank dollar field gets
 *    one of two answers: a number so high it never fires, or one so low it
 *    fires on an ordinary Tuesday. Both teach the reader the feature is
 *    useless. Twice their median day is neither, and it is a fact rather than
 *    a guess (rule 6).
 */
import { useEffect, useState } from 'react'
import { api, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { Panel } from '@/components/ui'
import { fmtUSD } from '@/lib/format'

export function SpendCap({ suggestion }: { suggestion?: number }) {
  const settings = useApi(() => api.settings(), [], { live: false })
  const [draft, setDraft] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  // Seeded once the daemon answers, and never again: re-seeding on every poll
  // would overwrite what someone is in the middle of typing.
  //
  // Keyed on the value rather than on the response object, because the first
  // render already has `settings.data` as undefined and the second carries the
  // number — an effect that fired on the object alone marked itself seeded
  // before the figure existed, and the field stayed empty beside a panel
  // reading "on $280". A control that does not show what it is set to is worse
  // than one that shows nothing.
  const [seeded, setSeeded] = useState(false)
  const stored = settings.data?.cap_usd_per_day
  useEffect(() => {
    if (seeded || stored === undefined) return
    setDraft(stored ? String(stored) : '')
    setSeeded(true)
  }, [stored, seeded])

  const current = settings.data?.cap_usd_per_day ?? 0
  const on = current > 0

  const save = async (value: number) => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      // A patch: PUT /v1/settings changes only the keys it names, so this
      // cannot clear the plan or the licence key by omission.
      await api.saveSettings({ cap_usd_per_day: value } as Partial<Settings> as Settings)
      setDraft(value ? String(value) : '')
      setSaved(true)
      settings.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const submit = () => {
    // Parsed as typed, not sanitised into something else.
    //
    // Stripping non-digits first turned "-5" into 5 and saved it: the guard
    // below could never fire, because the only input it would have rejected had
    // already been rewritten into a valid one. A field that silently changes
    // what you typed is worse than one that refuses it — and this number stops
    // work.
    const text = draft.trim().replace(/^\$/, '').replace(/,/g, '')
    const v = Number(text)
    if (text === '' || !Number.isFinite(v) || v < 0) {
      setError('A daily cap has to be a positive number of dollars.')
      return
    }
    void save(v)
  }

  return (
    <Panel
      title="Daily spend cap"
      right={
        <span className={on ? 'text-premium-strong' : 'text-fg-faint'}>{on ? 'on' : 'off'}</span>
      }
    >
      <div className="grid gap-2.5 px-3 py-3 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="text-fg-muted">Stop the day at</span>
          <span className="text-fg-muted">$</span>
          <input
            className="input w-28"
            inputMode="decimal"
            placeholder="0"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setSaved(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            aria-label="Daily spend cap in dollars"
          />
          <button
            onClick={submit}
            disabled={saving}
            className="rounded-sm bg-premium px-3 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {on && (
            <button
              onClick={() => void save(0)}
              disabled={saving}
              className="text-[12px] text-fg-faint hover:text-fg"
            >
              turn off
            </button>
          )}
          {saved && !error && <span className="text-[12px] text-fg-faint">saved</span>}
        </div>

        {/* Offered rather than prefilled: a number that appears in the field on
          * its own is a number nobody chose, and this one stops work. */}
        {!on && suggestion ? (
          <p className="text-[12px] text-fg-faint">
            Your days run about {fmtUSD(suggestion / 2)}.{' '}
            <button
              onClick={() => void save(suggestion)}
              className="text-premium-strong hover:underline"
            >
              Use {fmtUSD(suggestion)}
            </button>{' '}
            — twice that, so an ordinary day never trips it.
          </p>
        ) : null}

        {error && <p className="text-[12px] text-danger">{error}</p>}

        <p className="border-t border-border pt-2 text-[12px] leading-relaxed text-fg-faint">
          {on ? (
            <>
              When today crosses {fmtUSD(current)}, Caprock pauses the sessions it
              started — paused, not killed, so resuming keeps the conversation.
              Sessions you started yourself are never touched.
            </>
          ) : (
            <>
              Off. Nothing is paused, whatever the day costs. Sessions you
              started yourself are never touched either way.
            </>
          )}
        </p>
      </div>
    </Panel>
  )
}
