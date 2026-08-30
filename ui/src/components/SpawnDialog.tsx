import { useState } from 'react'
import { DirPicker } from './DirPicker'
import { api, errText } from '@/lib/api'
import { navigate } from '@/lib/router'

const MODELS = ['', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']
const MODES = ['', 'default', 'plan', 'acceptEdits', 'bypassPermissions']

export function SpawnDialog({
  available,
  onClose,
  // Where to start, when the caller already knows. Opening this from a session
  // whose repository is on screen and then asking for the directory again is
  // asking someone to retype what they are looking at.
  initialCwd = '',
}: {
  available: boolean
  onClose: () => void
  initialCwd?: string
}) {
  const [cwd, setCwd] = useState(initialCwd)
  const [model, setModel] = useState('')
  const [mode, setMode] = useState('')
  const [worktree, setWorktree] = useState('')
  const [create, setCreate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!cwd.trim()) { setError('Working directory is required.'); return }
    setBusy(true); setError('')
    try {
      const req: Parameters<typeof api.spawn>[0] = { cwd: cwd.trim() }
      if (model) req.model = model
      if (mode) req.permission_mode = mode
      if (worktree.trim()) req.worktree = worktree.trim()
      if (create) req.create = true
      const { session_id } = await api.spawn(req)
      onClose()
      navigate({ name: 'session', id: session_id, tab: 'terminal' })
    } catch (e) {
      // errText also surfaces `detail`, the half that says what to do about it.
      setError(errText(e))
    } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-20 bg-black/50 flex items-start justify-center pt-24" onClick={onClose}>
      <div className="border border-border-strong bg-panel rounded-[var(--radius-panel)] w-[520px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <header className="px-3 py-2 border-b border-border flex items-center">
          <h2 className="text-[12px] uppercase tracking-[0.08em] text-fg-muted">New session</h2>
          <button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">✕</button>
        </header>
        {!available ? (
          <div className="px-4 py-6 text-[13px] text-fg-muted">
            The <span className="mono">claude</span> binary was not found on this machine, so Caprock cannot spawn sessions. It still observes every session you start yourself.
          </div>
        ) : (
          <div className="px-4 py-3 grid gap-3 text-[13px]">
            <Field label="Working directory" hint="pick one, or type a path">
              <input autoFocus className="input" placeholder="/Users/you/dev/project" value={cwd} onChange={(e) => setCwd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
              {/* The lists write into the field above rather than replacing it,
                * so what will actually be used stays visible and editable. */}
              <div className="mt-1.5">
                <DirPicker value={cwd} onPick={setCwd} />
              </div>
              {/* Starting a new project meant leaving the dashboard, making the
                * folder in a terminal, and coming back — for a directory whose
                * name you had already typed here. Off by default: creating a
                * directory is a side effect, and a typo in an absolute path
                * should fail rather than quietly take up residence. */}
              <label className="mt-1.5 inline-flex items-center gap-1.5 cursor-pointer select-none text-[12px] text-fg-muted">
                <input type="checkbox" className="accent-[var(--color-accent)]" checked={create} onChange={(e) => setCreate(e.target.checked)} />
                create it if it does not exist
              </label>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Model"><select className="input" value={model} onChange={(e) => setModel(e.target.value)}>{MODELS.map((m) => <option key={m} value={m}>{m || 'default'}</option>)}</select></Field>
              <Field label="Permission mode"><select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>{MODES.map((m) => <option key={m} value={m}>{m || 'default'}</option>)}</select></Field>
            </div>
            <Field label="Git worktree" hint="optional — creates .caprock-worktrees/<name> on a new branch">
              <input className="input" placeholder="feature-x" value={worktree} onChange={(e) => setWorktree(e.target.value)} />
            </Field>
            {error && <div className="text-danger text-[12px]">{error}</div>}
          </div>
        )}
        {/* Said here because there is nowhere else a person would find it: the
          * agent filter only appears once OpenCode sessions exist, so someone
          * who has never run it cannot learn that Caprock would watch it. */}
        {available && (
          <div className="px-4 pb-3 text-[11px] leading-relaxed text-fg-faint">
            Caprock watches OpenCode sessions too — start one however you
            normally do and it appears here, priced, alongside these.
          </div>
        )}
        {available && (
          <footer className="px-4 py-2 border-t border-border flex gap-2 justify-end">
            <button onClick={onClose} className="border border-border px-3 py-1 rounded-sm text-fg-muted hover:text-fg">Cancel</button>
            <button onClick={submit} disabled={busy} className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm hover:bg-accent/25 disabled:opacity-50">{busy ? 'starting…' : 'Start session'}</button>
          </footer>
        )}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] text-fg-muted">{label}{hint && <span className="text-fg-faint"> · {hint}</span>}</span>
      {children}
    </label>
  )
}
