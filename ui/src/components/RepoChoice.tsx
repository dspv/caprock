/**
 * The Add project sheet's one question for a folder of repositories
 * (ADR-055): one project of N repositories, or N separate projects, with the
 * repositories found as checkboxes. One project is the default.
 */
import { foundNote, reposLabel, type AddChoice } from '@/lib/multirepo'
import type { ScanResult } from '@/lib/projects'

export function RepoChoice({
  scan,
  choice,
  onChoice,
  picked,
  onPicked,
}: {
  scan: ScanResult
  choice: AddChoice
  onChoice: (c: AddChoice) => void
  picked: ReadonlySet<string>
  onPicked: (next: Set<string>) => void
}) {
  const n = scan.repos.length
  const toggle = (path: string) => {
    const next = new Set(picked)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    onPicked(next)
  }
  const option = (c: AddChoice, label: string, hint: string) => (
    <label className={`flex cursor-pointer items-start gap-2 rounded-[8px] border px-3 py-2 ${choice === c ? 'border-accent/60 bg-accent/5' : 'border-[var(--app-hairline)]'}`}>
      <input type="radio" name="repo-choice" className="mt-[3px]" checked={choice === c} onChange={() => onChoice(c)} />
      <span className="min-w-0">
        <span className="block text-[13px] text-fg">{label}</span>
        <span className="block text-[12px] text-fg-muted">{hint}</span>
      </span>
    </label>
  )
  return (
    <section aria-label="Repositories found" className="grid gap-2 rounded-[10px] border border-[var(--app-hairline)] p-3">
      <p className="text-[12.5px] text-fg">
        This folder holds {reposLabel(n)}{scan.capped ? ' (and maybe more: the search stopped early)' : ''}. Add them as
      </p>
      <div role="radiogroup" aria-label="Add them as" className="grid gap-1.5 sm:grid-cols-2">
        {option('one', `One project of ${reposLabel(picked.size)}`, 'one row; agents start in the folder and reach every repository')}
        {option('separate', `${picked.size} separate project${picked.size === 1 ? '' : 's'}`, 'one row per repository, as if each were added alone')}
      </div>
      <ul aria-label="Repositories" className="grid max-h-[180px] gap-0.5 overflow-y-auto">
        {scan.repos.map((r) => {
          const note = foundNote(r)
          return (
            <li key={r.path}>
              <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12.5px] hover:bg-[var(--app-row-hover)]" title={r.path}>
                <input type="checkbox" checked={picked.has(r.path)} onChange={() => toggle(r.path)} />
                <span className="mono min-w-0 truncate text-fg">{r.name}</span>
                {note && <span className="ml-auto shrink-0 text-[12px] text-fg-faint">{note}</span>}
              </label>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
