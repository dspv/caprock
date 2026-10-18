import { useEffect, useMemo, useState } from 'react'
import { api, type CleanupQuery } from './mailApi'

/** Folder cleanup always reviews a server-selected snapshot, never the visible page. */
export function Cleanup({ view, account, accountName, onChanged }: {
  view: 'junk' | 'trash'
  account?: number
  accountName?: string
  onChanged: (message?: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  return <div className="cleanup">
    <button className="btn small" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
      {view === 'junk' ? 'Clean spam → Trash' : 'Clean Trash…'}
    </button>
    {open && <CleanupForm view={view} account={account} accountName={accountName} busy={busy} setBusy={setBusy}
      onChanged={onChanged} onClose={() => setOpen(false)} />}
  </div>
}

function CleanupForm({ view, account, accountName, busy, setBusy, onChanged, onClose }: {
  view: 'junk' | 'trash'; account?: number; accountName?: string; busy: boolean
  setBusy: (busy: boolean) => void; onChanged: (message?: string) => void; onClose: () => void
}) {
  const [days, setDays] = useState(view === 'trash' ? 30 : 0)
  const [score, setScore] = useState(0)
  const [revision, setRevision] = useState(0)
  const [preview, setPreview] = useState<{ query: CleanupQuery; ids: number[]; identities: Record<string, string> } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const query = useMemo<CleanupQuery>(() => ({ view, account: account ?? 0,
    before: days ? Date.now() - days * 86_400_000 : 0, min_score: score,
  }), [view, account, days, score, revision])
  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    setPreview(null)
    api.cleanupPreview(query).then((p) => { if (live) setPreview({ query, ids: p.ids, identities: p.identities }) })
      .catch((e: Error) => { if (live) setError(e.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [query])
  const run = async () => {
    if (!preview?.ids.length || busy) return
    setBusy(true)
    setError('')
    try {
      await api.cleanup({ ...preview.query, ids: preview.ids, identities: preview.identities })
      onChanged(view === 'junk' ? 'Spam moved to Trash' : 'Trash cleanup completed')
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setPreview(null)
      onChanged()
    } finally { setBusy(false) }
  }
  return <section className="cleanup-panel" aria-label={view === 'junk' ? 'Clean spam' : 'Clean Trash'} onKeyDown={(e) => e.stopPropagation()}>
    <p className="small"><strong>{accountName || 'All accounts'}</strong> · All synced messages, including those not loaded in this list.</p>
    <div className="cleanup-filters">
      <label className="small">Message age
        <select value={days} disabled={busy} onChange={(e) => { setPreview(null); setDays(Number(e.target.value)) }}>
          <option value={0}>Any age</option>
          <option value={7}>Older than 7 days</option>
          <option value={30}>Older than 30 days</option>
          <option value={90}>Older than 90 days</option>
        </select>
      </label>
      <label className="small">Spam score
        <select value={score} disabled={busy} onChange={(e) => { setPreview(null); setScore(Number(e.target.value)) }}>
          <option value={0}>{view === 'junk' ? 'All spam' : 'Any message'}</option>
          <option value={90}>90 or higher</option>
          <option value={75}>75 or higher</option>
          <option value={50}>50 or higher</option>
        </select>
      </label>
    </div>
    {days > 0 && <p className="small muted">Age is based on the message date, not when it entered Trash.</p>}
    {score > 0 && <p className="small muted">Caprock’s junk score, not a probability. Mail flagged only by your provider or AI is excluded.</p>}
    <p className="small" role="status">{loading ? 'Counting messages…' : preview ? `${preview.ids.length} message${preview.ids.length === 1 ? '' : 's'} match.` : 'Refresh the preview before trying again.'}</p>
    {view === 'trash' && <p className="small">These messages will be permanently deleted from the mail server. This cannot be undone.</p>}
    {error && <p className="small" role="alert">{error}</p>}
    <div className="cleanup-actions">
      <button className="btn small" disabled={busy} onClick={onClose}>Cancel</button>
      {error && <button className="btn small" disabled={busy || loading} onClick={() => setRevision((v) => v + 1)}>Refresh preview</button>}
      <button className={'btn small ' + (view === 'trash' ? 'danger' : 'primary')} disabled={busy || loading || !preview?.ids.length} onClick={() => void run()}>
        {busy ? 'Cleaning…' : view === 'junk' ? `Move ${preview?.ids.length ?? 0} to Trash` : `Delete ${preview?.ids.length ?? 0} forever`}
      </button>
    </div>
  </section>
}
