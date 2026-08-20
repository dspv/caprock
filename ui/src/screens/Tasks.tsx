import { useState } from 'react'
import { api, type Task } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtUSD, shortId } from '@/lib/format'
import { Empty } from '@/components/ui'

const COLUMNS: { key: string; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'assigned', label: 'Assigned' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'verifying', label: 'Verifying' },
  { key: 'needs_you', label: 'Needs you' },
  { key: 'done', label: 'Done' },
]

export function TasksScreen() {
  const status = useApi(() => api.status(), [], { live: false, intervalMs: 30000 })
  const tasks = useApi(() => api.tasks(), [], { intervalMs: 4000 })
  const [creating, setCreating] = useState(false)
  if (status.data && status.data.orchestration === false) {
    return <Empty title="Orchestration is off">Phase 2 runs when the daemon is started with a hive directory (<span className="mono">caprock up --hive &lt;dir&gt;</span>).</Empty>
  }
  const byCol = (col: string) => (tasks.data ?? []).filter((t) => t.status === col || (col === 'done' && t.status === 'failed'))
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <button onClick={() => setCreating(true)} className="border border-accent/50 text-accent bg-accent/10 px-2 py-1 rounded-sm text-[12px] hover:bg-accent/20">+ New task</button>
        <OrchestratorButton available={status.data?.claude_available ?? false} />
        {/* The graph is only meaningful while work is actually assigned, so it
         * is reachable from here rather than from a permanent nav slot. */}
        {(tasks.data ?? []).some((t) => t.assignee !== '' && t.status !== 'done' && t.status !== 'failed') && (
          <a href="#/graph" className="link text-[12px] border border-border px-2 py-1 rounded-sm hover:border-border-strong">view graph</a>
        )}
        <span className="ml-auto text-[11px] text-fg-faint">Tasks are files on disk (<span className="mono">tasks/&lt;id&gt;.md</span>); the orchestrator moves them. Nothing reaches Done until its <span className="mono">done_criteria</span> pass.</span>
      </div>
      {tasks.error && !tasks.data && <Empty title="Cannot reach the daemon">{tasks.error.message}</Empty>}
      <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {COLUMNS.map((c) => (
          <div key={c.key} className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.08em] text-fg-faint mb-1.5 px-0.5 flex justify-between">
              <span>{c.label}</span><span className="num">{byCol(c.key).length}</span>
            </div>
            <div className="grid gap-1.5 content-start min-h-[60px]">
              {byCol(c.key).map((t) => <TaskCard key={t.id} t={t} onApprove={() => tasks.refresh()} />)}
            </div>
          </div>
        ))}
      </div>
      {creating && <NewTask onClose={() => { setCreating(false); tasks.refresh() }} />}
    </div>
  )
}

function OrchestratorButton({ available }: { available: boolean }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const start = async () => {
    setBusy(true); setMsg('')
    try { const r = await api.startOrchestrator(); setMsg('orchestrator: ' + r.session_id.slice(0, 8)) }
    catch (e) { setMsg(String(e)) } finally { setBusy(false) }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button disabled={busy || !available} onClick={start} title={available ? 'spawn the orchestrator session' : 'claude not found — cannot spawn'} className="border border-border text-fg-muted px-2 py-1 rounded-sm text-[12px] hover:text-fg disabled:opacity-50">{busy ? 'starting…' : '▶ Start orchestrator'}</button>
      {msg && <span className="text-[11px] text-fg-faint mono">{msg}</span>}
    </span>
  )
}

function TaskCard({ t, onApprove }: { t: Task; onApprove: () => void }) {
  const over = t.budget_usd > 0 && t.cost_usd > t.budget_usd
  return (
    <div className="border border-border bg-panel rounded-[var(--radius-panel)] px-2 py-1.5">
      <div className="text-[12px] font-medium truncate" title={t.title}>{t.title || t.id}</div>
      <div className="flex items-center gap-2 mt-1 text-[10px] text-fg-faint">
        <span className="mono">{shortId(t.id)}</span>
        {t.assignee && <span className="mono text-fg-muted">→ {t.assignee}</span>}
        <span className={`num ml-auto ${over ? 'text-danger' : 'text-fg-muted'}`}>{fmtUSD(t.cost_usd)}{t.budget_usd > 0 ? ` / ${fmtUSD(t.budget_usd)}` : ''}</span>
      </div>
      {t.status === 'needs_you' && (
        <div className="flex gap-1 mt-1.5">
          <button onClick={() => api.approve(t.id, true).then(onApprove)} className="flex-1 text-[11px] border border-ok/40 text-ok rounded-sm hover:bg-ok/10">approve</button>
          <button onClick={() => api.approve(t.id, false).then(onApprove)} className="flex-1 text-[11px] border border-danger/40 text-danger rounded-sm hover:bg-danger/10">reject</button>
        </div>
      )}
    </div>
  )
}

function NewTask({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [budget, setBudget] = useState('3')
  const [criteria, setCriteria] = useState('go test ./...\ngo vet ./...')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!title.trim()) { setError('Title is required.'); return }
    setBusy(true); setError('')
    try {
      await api.createTask({ title: title.trim(), budget_usd: parseFloat(budget) || 0, done_criteria: criteria.split('\n').map((s) => s.trim()).filter(Boolean), body })
      onClose()
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-20 bg-black/50 flex items-start justify-center pt-24" onClick={onClose}>
      <div className="border border-border-strong bg-panel rounded-[var(--radius-panel)] w-[560px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <header className="px-3 py-2 border-b border-border flex items-center"><h2 className="text-[12px] uppercase tracking-[0.08em] text-fg-muted">New task</h2><button onClick={onClose} className="ml-auto text-fg-muted hover:text-fg">✕</button></header>
        <div className="px-4 py-3 grid gap-3 text-[13px]">
          <label className="grid gap-1"><span className="text-[11px] text-fg-muted">Title</span><input autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add /healthz endpoint" /></label>
          <label className="grid gap-1"><span className="text-[11px] text-fg-muted">Budget (USD)</span><input className="input" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
          <label className="grid gap-1"><span className="text-[11px] text-fg-muted">Done criteria · one command per line</span><textarea className="input" rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} /></label>
          <label className="grid gap-1"><span className="text-[11px] text-fg-muted">Description</span><textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></label>
          {error && <div className="text-danger text-[12px]">{error}</div>}
        </div>
        <footer className="px-4 py-2 border-t border-border flex gap-2 justify-end">
          <button onClick={onClose} className="border border-border px-3 py-1 rounded-sm text-fg-muted hover:text-fg">Cancel</button>
          <button onClick={submit} disabled={busy} className="border border-accent bg-accent/15 text-accent px-3 py-1 rounded-sm hover:bg-accent/25 disabled:opacity-50">{busy ? 'creating…' : 'Create task'}</button>
        </footer>
      </div>
    </div>
  )
}
