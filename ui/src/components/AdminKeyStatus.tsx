/**
 * The admin key's state (ADR-076), in Settings → Plan, only while one is
 * stored: which private modules it opens, and *remove* on the machine.
 *
 * There is no key field any more. Caprock has no paid plan for one person
 * (2026-11-27, ADR-022 amended), so nobody pastes a licence key; an admin key
 * is set from the terminal with `caprock license set <CRA1 key>`.
 */
import { useState } from 'react'
import { api, errText, isPairedDevice } from '@/lib/api'
import { announceAdmin, useAdmin } from '@/lib/modules'

export function AdminKeyStatus() {
  const admin = useAdmin()
  const [err, setErr] = useState('')
  if (!admin?.admin && !admin?.key_error) return null
  const clear = () => { api.clearAdminKey().then(announceAdmin).catch((e) => setErr(errText(e))) }
  return (
    <p className="border-t border-border pt-3 text-[11px] leading-relaxed">
      {admin.admin && (
        <span data-admin-key className="block text-ok">
          Admin key is on{admin.modules?.length ? ` — ${admin.modules.join(', ')}` : ''}.{' '}
          {/* The key is removed on the machine only (ADR-076). */}
          {!isPairedDevice() && <button type="button" onClick={clear} className="link">remove</button>}
        </span>
      )}
      {admin.key_error && <span className="block text-warn">The stored admin key is not valid: {admin.key_error}.</span>}
      {err && <span className="block text-danger">{err}</span>}
    </p>
  )
}
