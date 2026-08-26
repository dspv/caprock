/**
 * Where a paid key is pasted, and what it says back.
 *
 * The one interaction that turns a payment into a working feature. Everything
 * about it is shaped by that: it accepts a key with whitespace around it, it
 * says what is wrong in words rather than "invalid", and it confirms out loud
 * when a key is working — because someone who has just paid needs to see that
 * something happened.
 *
 * The check runs on the machine against the expiry inside the key. Saying so
 * here is not marketing: a person pasting a licence into a tool that promises
 * nothing leaves their disk is entitled to know this one did not just make a
 * request either.
 */
import { useEffect, useState } from 'react'
import { api, type PremiumPricing, type Settings } from '@/lib/api'
import { useApi } from '@/lib/useApi'

export function LicenseField({ plan, save }: { plan: Settings; save: (s: Settings) => void }) {
  const [draft, setDraft] = useState(plan.license_key ?? '')
  const premium = useApi(() => api.premium(), [plan.license_key])
  const lic = premium.data?.license

  // The field follows the saved value when it changes elsewhere (a second tab,
  // a config edit), but not while it is being typed into.
  useEffect(() => { setDraft(plan.license_key ?? '') }, [plan.license_key])

  const dirty = draft.trim() !== (plan.license_key ?? '').trim()

  return (
    <div className="border-t border-border pt-2">
      <div className="flex items-baseline gap-2">
        <span className="w-28 shrink-0 text-fg-muted">Licence</span>
        <input
          className="input flex-1 min-w-0"
          placeholder="CR-…"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && dirty) save({ ...plan, license_key: draft.trim() }) }}
        />
        <button
          disabled={!dirty}
          onClick={() => save({ ...plan, license_key: draft.trim() })}
          className="rounded-sm border border-border px-2 py-0.5 text-fg-muted hover:border-border-strong hover:text-fg disabled:opacity-40"
        >
          save
        </button>
      </div>

      <p className="mt-1.5 pl-[7.5rem] text-[11px] leading-relaxed">
        {lic?.active && !lic.in_grace && (
          <span className="text-ok">
            Premium is on{lic.expires_at ? ` — renews ${lic.expires_at.slice(0, 10)}` : ''}.
          </span>
        )}
        {lic?.active && lic.in_grace && (
          // Loud, because this is the window in which a failed renewal can
          // still be fixed before anything stops working.
          <span className="text-warn">{lic.reason}. Update your key or payment method.</span>
        )}
        {lic && !lic.active && (
          <span className="text-fg-muted">
            {plan.license_key ? lic.reason : 'No key — the free product is unaffected.'}{' '}
            <a href="https://caprock.dev/premium/" target="_blank" rel="noreferrer" className="link">
              what Premium does
            </a>
          </span>
        )}
        <span className="block text-fg-faint">
          Checked on this machine against the date inside the key. Caprock makes
          no call to us to verify it.
        </span>
      </p>
    </div>
  )
}

export type { PremiumPricing }
