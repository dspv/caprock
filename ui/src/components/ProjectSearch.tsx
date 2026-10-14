/**
 * The project search both sheets share (lib/projectSearch.ts says what it
 * searches and how it ranks).
 *
 * - `useProjectCandidates` asks the daemon once for recent folders and the
 *   repositories under the default folder, and merges them with the projects.
 * - `CandidateList` draws a ranked list: the matched letters in bold, a word
 *   saying where each came from, the path as the user writes it.
 * - `ProjectCombobox` is New agent's Project field: a text field that opens
 *   the list, ↑↓ moves, Enter picks (and, with the list closed, starts), Esc
 *   closes the list before it closes the sheet.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { keys } from '@/lib/appkeys'
import { useEscapeToClose } from './Dialog'
import type { Project } from '@/lib/projects'
import { mergeCandidates, rankCandidates, tildePath, type Candidate, type Ranked } from '@/lib/projectSearch'

export function useProjectCandidates(projects: readonly Project[]): { candidates: Candidate[]; home?: string; root?: string } {
  const recent = useApi(() => api.recentDirs(), [], { live: false })
  const repos = useApi(() => api.localRepos(), [], { live: false })
  const candidates = useMemo(() => mergeCandidates([
    projects.map((p): Candidate => ({ kind: 'project', path: p.root, name: p.name, projectId: p.id })),
    (recent.data ?? []).map((d): Candidate => ({ kind: 'recent', path: d.dir, name: d.name })),
    (repos.data?.repos ?? []).map((r): Candidate => ({ kind: 'repo', path: r.path, name: r.name })),
  ]), [projects, recent.data, repos.data])
  return { candidates, home: repos.data?.home, root: repos.data?.root }
}

const KIND_LABEL: Record<Candidate['kind'], string> = { project: 'project', recent: 'recent · add', repo: 'repo · add' }

/** The name with its matched letters in bold. */
function Highlit({ name, hits }: { name: string; hits: number[] }) {
  if (hits.length === 0) return <>{name}</>
  const set = new Set(hits)
  return (
    <>
      {[...name].map((ch, i) => (set.has(i) ? <b key={i} className="font-semibold text-fg">{ch}</b> : <span key={i}>{ch}</span>))}
    </>
  )
}

export function CandidateList({
  id,
  items,
  active,
  home,
  onPick,
  onHover,
  label,
}: {
  id: string
  items: Ranked[]
  active: number
  home?: string
  onPick: (c: Ranked) => void
  onHover?: (i: number) => void
  label: string
}) {
  const ref = useRef<HTMLUListElement>(null)
  useEffect(() => {
    ref.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  return (
    <ul ref={ref} id={id} role="listbox" aria-label={label} className="app-scroll grid max-h-[232px] gap-px overflow-y-auto">
      {items.map((c, i) => (
        <li
          key={c.path}
          id={`${id}-${i}`}
          data-i={i}
          role="option"
          aria-selected={i === active}
          // mousedown, not click: the field keeps focus, so the list does not
          // close under the pointer before the pick lands.
          onMouseDown={(e) => { e.preventDefault(); onPick(c) }}
          onMouseEnter={() => onHover?.(i)}
          className={`flex h-[34px] cursor-default select-none items-center gap-2 rounded-[6px] px-2.5 ${i === active ? 'bg-accent/15' : 'hover:bg-[var(--app-row-hover)]'}`}
        >
          <span className="min-w-0 shrink-0 truncate text-[13px] text-fg-muted" style={{ maxWidth: '45%' }}>
            <Highlit name={c.name} hits={c.hits} />
          </span>
          <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-fg-faint" title={c.path}>{tildePath(c.path, home)}</span>
          <span className={`shrink-0 text-[10.5px] ${c.kind === 'project' ? 'text-fg-faint' : 'text-accent'}`}>{KIND_LABEL[c.kind]}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * New agent's Project field. Shows the chosen project's name; focused, it is
 * a search with the chosen project first, so Enter keeps it and a second
 * Enter starts.
 */
export function ProjectCombobox({
  projects,
  value,
  onPick,
  onSubmit,
  busy,
  autoFocus,
  onNewProject,
}: {
  projects: readonly Project[]
  /** The list's last row, New project…: the wizard (components/ProjectWizard.tsx). */
  onNewProject?: () => void
  /** The chosen project's id. */
  value: string
  onPick: (c: Candidate) => void
  /** Enter with the list closed: start. */
  onSubmit?: () => void
  /** A pick that adds a project is in flight. */
  busy?: boolean
  autoFocus?: boolean
}) {
  const id = useId().replace(/:/g, '')
  const { candidates, home } = useProjectCandidates(projects)
  const chosen = projects.find((p) => p.id === value)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const items = useMemo(() => {
    const ranked = rankCandidates(query, candidates, 50, home)
    if (query.trim() || !chosen) return ranked
    // Unfiltered, the chosen project leads: Enter keeps it.
    const at = ranked.findIndex((c) => c.projectId === chosen.id)
    return at > 0 ? [ranked[at]!, ...ranked.slice(0, at), ...ranked.slice(at + 1)] : ranked
  }, [query, candidates, chosen, home])
  useEffect(() => { setActive(0) }, [query])
  // Esc closes the list first, and the sheet only on a second press.
  useEscapeToClose(() => { setOpen(false); setQuery('') }, open)

  const pick = (c: Ranked | undefined) => {
    if (!c) return
    setOpen(false)
    setQuery('')
    onPick(c)
  }
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) { setOpen(true); e.preventDefault(); e.stopPropagation(); return }
      setActive((i) => Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      if (open) pick(items[active])
      else onSubmit?.()
    } else {
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className="relative min-w-0">
      <input
        className="input w-full"
        role="combobox"
        aria-label="Project"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && items.length ? `${id}-list-${active}` : undefined}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        placeholder={chosen ? chosen.name : 'Search projects and repositories'}
        value={open ? query : busy ? 'Adding…' : chosen?.name ?? ''}
        onFocus={() => { setOpen(true); setQuery('') }}
        onBlur={() => { setOpen(false); setQuery('') }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onKeyDown={onKey}
      />
      {open && (
        // As wide as the row the field sits in (two columns and their gap), so
        // a path and where it came from fit beside the name.
        <div className="absolute left-0 top-[calc(100%+4px)] z-20 max-w-[calc(100vw-48px)] rounded-[8px] border border-[var(--app-hairline-strong)] bg-panel p-1 shadow-lg" style={{ width: 'calc(200% + 12px)' }}>
          {items.length > 0 ? (
            <CandidateList id={`${id}-list`} label="Projects and repositories" items={items} active={active} home={home} onPick={pick} onHover={setActive} />
          ) : (
            <p className="px-2.5 py-2 text-[12.5px] text-fg-faint">Nothing called “{query.trim()}” here. Add a project with {keys('⌘O')} to look elsewhere.</p>
          )}
          {onNewProject && (
            // mousedown, not click: the field's blur closes the list first.
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => { e.preventDefault(); setOpen(false); onNewProject() }}
              className="mt-1 flex h-[32px] w-full items-center gap-2 rounded-[6px] border-t border-[var(--app-hairline)] px-2.5 text-left text-[13px] text-accent hover:bg-[var(--app-row-hover)]"
            >
              New project… <span className="text-[12px] text-fg-muted">a repository, a monorepo or several repositories</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
