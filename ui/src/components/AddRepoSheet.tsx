/**
 * *Add a repository…* from a project's menu (ADR-077; owner, 2026-10-18,
 * translated: "I still can't understand how to make multi-repo projects"):
 * a folder field with the folders inside it, each repository a checkbox,
 * the picks kept while moving between folders, and *Add N* — `PATCH
 * /v1/projects/{id}` with the project's repositories and the ticked ones.
 * A plain repository project becomes one of several, its own repository the
 * home one; untick in the project editor, or split it there. Nothing on disk
 * is touched.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, errText } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { projectsApi, type Project } from '@/lib/projects'
import { tildePath } from '@/lib/projectSearch'
import { drillPath, expandTilde, parentOf, togglePick, trimSlash } from '@/lib/projectWizard'
import { addedRepos } from '@/lib/multirepo'
import { Sheet, SheetButton } from './Sheet'

export function AddRepoSheet({ project, onClose, onChanged }: { project: Project; onClose: () => void; onChanged?: () => void }) {
  const local = useApi(() => api.localRepos(), [], { live: false })
  const home = local.data?.home
  const [path, setPath] = useState(() => parentOf(project.root) || project.root)
  // The field reads in ~ form once the home folder is known.
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!touched && home) setPath(tildePath(parentOf(project.root) || project.root, home))
  }, [home, touched, project.root])
  const [dir, setDir] = useState(path)
  useEffect(() => {
    const t = setTimeout(() => setDir(path.trim()), 250)
    return () => clearTimeout(t)
  }, [path])
  const listing = useApi(() => (dir ? api.browse(expandTilde(trimSlash(dir), home)) : Promise.resolve(null)), [dir, home], { live: false })
  const [picks, setPicks] = useState<Map<string, string>>(() => new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const members = useMemo(() => new Set([project.root, ...(project.repos ?? []).map((r) => r.path)].map(trimSlash)), [project])
  const entries = listing.data?.entries ?? []

  const add = async () => {
    if (picks.size === 0) { setError('Tick a repository to add.'); return }
    setBusy(true)
    setError('')
    try {
      await projectsApi.patch(project.id, { repos: addedRepos(project, [...picks.keys()]) })
      onChanged?.()
      onClose()
    } catch (e) {
      setError(errText(e))
      setBusy(false)
    }
  }

  return (
    <Sheet
      label={`Add a repository to ${project.name}`}
      title={`Add a repository to ${project.name}`}
      onClose={onClose}
      width={600}
      footer={
        <>
          {error ? <p role="alert" className="mr-auto min-w-0 truncate text-[13px] text-danger" title={error}>{error}</p> : <span className="mr-auto min-w-0 truncate text-[12.5px] text-fg-muted">No folder is made or moved.</span>}
          <SheetButton onClick={onClose}>Cancel</SheetButton>
          <SheetButton primary disabled={busy || picks.size === 0} onClick={() => void add()}>
            {busy ? 'Adding…' : picks.size > 1 ? `Add ${picks.size} repositories` : 'Add repository'}
          </SheetButton>
        </>
      }
    >
      <div className="grid min-w-0 gap-3 px-5 py-4">
        <p className="text-[13.5px] text-fg-muted">
          {project.repos?.length
            ? <>{project.name} has {project.repos.length} repositories. Tick more, in any folder: agents started in one reach the others.</>
            : <>{project.name} becomes a project of several repositories: agents start in <span className="mono text-fg">{tildePath(project.root, home)}</span> and reach the ones ticked here.</>}
        </p>
        <input
          aria-label="Folder"
          className="input h-[38px]"
          spellCheck={false}
          autoComplete="off"
          value={path}
          onChange={(e) => { setPath(e.target.value); setTouched(true); setError('') }}
        />
        {listing.error ? <p role="status" className="text-[12.5px] text-fg-muted">{errText(listing.error)}</p> : null}
        <ul aria-label="Folders" className="app-scroll grid max-h-[300px] grid-cols-[minmax(0,1fr)] gap-px overflow-y-auto rounded-[10px] border border-[var(--app-hairline)] bg-[var(--app-hairline)]">
          {entries.map((e) => {
            const already = members.has(trimSlash(e.path))
            const ticked = picks.has(e.path)
            return (
              <li key={e.path} className="flex min-w-0 bg-panel">
                {e.repo ? (
                  <label className={`app-row flex h-[40px] min-w-0 flex-1 items-center gap-3 px-3.5 ${already ? 'opacity-60' : 'cursor-pointer'}`} title={e.path}>
                    <input type="checkbox" className="h-[16px] w-[16px] shrink-0" disabled={already} checked={already || ticked} onChange={() => setPicks((m) => togglePick(m, e.path, e.name))} aria-label={e.name} />
                    <span className="mono min-w-0 flex-1 truncate text-[13.5px] text-fg">{e.name}</span>
                    <span className="shrink-0 text-[12px] text-fg-muted">{already ? 'in this project' : 'git'}</span>
                  </label>
                ) : (
                  <button type="button" onClick={() => { setPath(drillPath(e.path, home)); setTouched(true) }} className="app-row flex h-[40px] min-w-0 flex-1 items-center gap-3 px-3.5 text-left" title={`Look inside ${e.name}`}>
                    <span aria-hidden="true" className="w-[16px] shrink-0" />
                    <span className="mono min-w-0 flex-1 truncate text-[13.5px] text-fg-muted">{e.name}</span>
                    <span aria-hidden="true" className="shrink-0 text-[15px] text-fg-muted">›</span>
                  </button>
                )}
              </li>
            )
          })}
          {entries.length === 0 && !listing.error && <li className="bg-panel px-3.5 py-3 text-[12.5px] text-fg-muted">{listing.loading ? 'Looking…' : 'No folders here.'}</li>}
        </ul>
        {picks.size > 0 && (
          <p className="mono min-w-0 truncate text-[12.5px] text-fg-muted" title={[...picks.keys()].join('\n')}>
            <span className="font-sans">Ticked: </span>{[...picks.values()].join(', ')}
          </p>
        )}
      </div>
    </Sheet>
  )
}
