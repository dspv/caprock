/**
 * The Files tab on the dashboard (`#/files?project=<id>[&wt=<name>]`,
 * ADR-089): the same two panels the app's Files tab holds, for a browser or
 * a paired phone, where it is read-only (the daemon says `writable: false`
 * and refuses every write from a device). Without a project, a list to pick
 * one from.
 */
import { useEffect, useState } from 'react'
import { FilesCommander, type FilesRoot } from '@/components/FilesCommander'
import { errText } from '@/lib/api'
import { projectsApi, type Project } from '@/lib/projects'
import { href } from '@/lib/router'

function rootsOf(p: Project): FilesRoot[] {
  const out: FilesRoot[] = [{ key: '', name: p.name, branch: p.branch ?? p.default_branch ?? '', path: p.root }]
  for (const w of p.worktrees ?? []) {
    if (!w.path || w.path === p.root) continue
    out.push({ key: w.name, name: w.path.split(/[\\/]/).filter(Boolean).pop() ?? w.name, branch: w.branch, path: w.path })
  }
  return out
}

export function FilesScreen({ project, wt }: { project?: string; wt?: string }) {
  const [list, setList] = useState<Project[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    projectsApi.list().then(setList).catch((e: unknown) => setErr(errText(e)))
  }, [])
  if (err) return <p className="text-danger text-sm">{err}</p>
  if (!list) return <p className="text-fg-faint text-sm">Loading projects…</p>
  const p = list.find((x) => x.id === project)
  if (!p) {
    return (
      <div className="max-w-xl">
        <h1 className="text-lg font-semibold mb-1">Files</h1>
        <p className="text-sm text-fg-muted mb-3">Two panels over a project and its agents’ worktrees. Pick a project:</p>
        <ul className="grid gap-1">
          {list.filter((x) => x.root).map((x) => (
            <li key={x.id}><a className="block rounded-md px-3 py-2 hover:bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]" href={href({ name: 'files', project: x.id })}>{x.name} <span className="text-fg-faint text-xs font-mono">{x.root}</span></a></li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div className="h-[calc(100dvh-120px)] max-sm:h-[calc(100dvh-210px)] min-h-[420px] rounded-xl overflow-hidden border border-border">
      <FilesCommander projectId={p.id} projectName={p.name} roots={rootsOf(p)} startRight={wt} visible />
    </div>
  )
}
