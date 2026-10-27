/**
 * Settings → Privacy: the share cards this machine uploaded to caprock.dev
 * (ADR-086), each with Remove. Drawn only when there is one, so the section
 * stays a paragraph for everyone who never posted a card. Removing deletes
 * the picture on caprock.dev with the token the daemon kept; the social site
 * may keep the preview it already fetched, and the line says so.
 */
import { useEffect, useState } from 'react'
import { api, errText, type SharedCard } from '@/lib/api'
import { fmtAgo } from '@/lib/format'
import { extTitle } from '@/lib/externalLinks'

export function SharedPictures() {
  const [items, setItems] = useState<SharedCard[] | undefined>(undefined)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    Promise.resolve().then(() => api.sharedCards()).then((r) => { if (live) setItems(r.items ?? []) }).catch(() => { if (live) setItems([]) })
    return () => { live = false }
  }, [])
  if (!items || items.length === 0) return null
  const remove = async (id: string) => {
    setBusy(id); setErr('')
    try {
      await api.removeSharedCard(id)
      setItems((l) => (l ?? []).filter((c) => c.id !== id))
    } catch (e) {
      setErr(`Could not remove it: ${errText(e)}`)
    } finally { setBusy('') }
  }
  const now = Date.now()
  return (
    <div data-shared-pictures className="mt-3">
      <div className="text-[12.5px] font-medium text-fg">Pictures you shared to caprock.dev</div>
      <ul className="mt-1 grid gap-1">
        {items.map((c) => (
          <li key={c.id} className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <a href={c.url} target="_blank" rel="noopener noreferrer" title={extTitle('The card’s page on caprock.dev')} className="mono min-w-0 truncate text-fg-muted underline-offset-2 hover:text-fg hover:underline">
              {c.url.replace(/^https?:\/\//, '')}
            </a>
            <span className="shrink-0 text-fg-faint">{fmtAgo(c.at, now)}</span>
            <button type="button" onClick={() => void remove(c.id)} disabled={busy === c.id}
              className="ml-auto shrink-0 rounded-md border border-border px-2 py-0.5 text-[12px] text-fg hover:border-border-strong disabled:opacity-50">
              {busy === c.id ? 'Removing…' : 'Remove'}
            </button>
          </li>
        ))}
      </ul>
      {err && <p className="mt-1 text-[12px] text-warn">{err}</p>}
      {/* Shown whatever the explanations setting says: it is what Remove can and cannot do. */}
      <p className="mt-1 text-[12px] text-fg-faint" data-keep>Remove deletes the picture on caprock.dev. A site you posted it to may keep the preview it already fetched.</p>
    </div>
  )
}
