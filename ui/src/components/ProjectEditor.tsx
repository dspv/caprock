/**
 * Editing a multi-repo project (ADR-055): rename it, tick and untick its
 * repositories, *Rescan* its folder for repositories added since, merge
 * repository projects into it, or split it into one project per repository.
 * Nothing here deletes a file: an unticked repository only leaves the
 * project, and a split or merge only changes the list.
 */
import { useState } from 'react'
import { errText } from '@/lib/api'
import { projectsApi, type FoundRepo, type Project } from '@/lib/projects'
import { editedRepos, foundNote, mergeCandidates, reposLabel } from '@/lib/multirepo'
import { Sheet, SheetButton, SheetField } from './Sheet'

export function ProjectEditor({ project, projects, onClose }: { project: Project; projects: readonly Project[]; onClose: () => void }) {
  const current = (project.repos ?? []).map((r) => r.path)
  const [name, setName] = useState(project.name)
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(current))
  const [found, setFound] = useState<FoundRepo[]>([])
  const [scanned, setScanned] = useState('')
  const [merge, setMerge] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmSplit, setConfirmSplit] = useState(false)
  const candidates = mergeCandidates(project, projects)
  const flip = (set: Set<string>, key: string) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }

  const rescan = async () => {
    setError('')
    try {
      const res = await projectsApi.scan(project.root)
      const fresh = res.repos.filter((r) => !current.includes(r.path))
      setFound(fresh)
      setScanned(fresh.length === 0 ? 'No other repositories in this folder.' : `${reposLabel(fresh.length)} not in the project yet: tick to add.`)
    } catch (e) {
      setError(errText(e))
    }
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const patch: { name?: string; repos?: string[] } = {}
      if (name.trim() && name.trim() !== project.name) patch.name = name.trim()
      const repos = editedRepos(current, found, ticked)
      if (repos.length !== current.length || repos.some((p) => !current.includes(p))) patch.repos = repos
      if (patch.name !== undefined || patch.repos !== undefined) await projectsApi.patch(project.id, patch)
      if (merge.size > 0) await projectsApi.merge([project.id, ...merge])
      onClose()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const split = async () => {
    setBusy(true)
    setError('')
    try {
      await projectsApi.split(project.id)
      onClose()
    } catch (e) {
      setError(errText(e))
      setBusy(false)
    }
  }

  const removed = current.filter((p) => !ticked.has(p)).length
  return (
    <Sheet
      label="Edit project"
      title={`Edit ${project.name}`}
      onClose={onClose}
      footer={
        <>
          {error && <p role="alert" className="mr-auto min-w-0 truncate text-[12px] text-danger" title={error}>{error}</p>}
          {!error && confirmSplit && (
            <p className="mr-auto min-w-0 text-[12px] text-fg-muted">One project per repository; this one leaves the list. No file is touched.</p>
          )}
          {confirmSplit ? (
            <>
              <SheetButton onClick={() => setConfirmSplit(false)}>Back</SheetButton>
              <SheetButton primary disabled={busy} onClick={() => void split()}>Split into {current.length}</SheetButton>
            </>
          ) : (
            <>
              <SheetButton onClick={() => setConfirmSplit(true)} disabled={busy || current.length === 0}>Split…</SheetButton>
              <SheetButton onClick={onClose}>Cancel</SheetButton>
              <SheetButton primary disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</SheetButton>
            </>
          )}
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 px-5 py-4">
        <SheetField label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </SheetField>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-medium text-fg">Repositories</span>
            <span className="mono min-w-0 truncate text-[12px] text-fg-faint" title={project.root}>{project.root}</span>
            <button type="button" onClick={() => void rescan()} className="ml-auto shrink-0 rounded-[6px] px-2 py-0.5 text-[12.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
              Rescan
            </button>
          </div>
          <ul aria-label="Repositories in this project" className="grid gap-0.5">
            {(project.repos ?? []).map((r) => (
              <li key={r.path}>
                <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12.5px] hover:bg-[var(--app-row-hover)]" title={r.path}>
                  <input type="checkbox" checked={ticked.has(r.path)} onChange={() => setTicked((t) => flip(t, r.path))} />
                  <span className="mono min-w-0 truncate text-fg">{r.name}</span>
                  {!r.exists && <span className="ml-auto text-[12px] text-danger">folder missing</span>}
                </label>
              </li>
            ))}
            {found.map((r) => (
              <li key={r.path}>
                <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12.5px] hover:bg-[var(--app-row-hover)]" title={r.path}>
                  <input type="checkbox" checked={ticked.has(r.path)} onChange={() => setTicked((t) => flip(t, r.path))} />
                  <span className="mono min-w-0 truncate text-fg">{r.name}</span>
                  <span className="ml-auto text-[12px] text-fg-faint">{foundNote(r) || 'new'}</span>
                </label>
              </li>
            ))}
          </ul>
          {scanned && <p role="status" className="text-[12px] text-fg-muted">{scanned}</p>}
          {removed > 0 && <p className="text-[12px] text-fg-muted">{removed} will leave the project. Their folders and files stay as they are.</p>}
        </div>
        {candidates.length > 0 && (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
            <span className="text-[12.5px] font-medium text-fg">Merge in</span>
            <ul aria-label="Projects to merge in" className="grid max-h-[160px] gap-0.5 overflow-y-auto">
              {candidates.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12.5px] hover:bg-[var(--app-row-hover)]" title={p.root}>
                    <input type="checkbox" checked={merge.has(p.id)} onChange={() => setMerge((m) => flip(m, p.id))} />
                    <span className="min-w-0 truncate text-fg">{p.name}</span>
                    <span className="mono ml-auto min-w-0 truncate text-[12px] text-fg-faint">{p.root}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Sheet>
  )
}
