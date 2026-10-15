/**
 * The Work board's "Next release" strip (.ai/04-ui.md § Work), one block per
 * repository with something to say: how long since its last tag and its usual
 * gap — "2h 05m since v0.117.4 · usual gap 2h 40m (median of 9)", the gap
 * only with enough releases behind it — the merged pull requests waiting for
 * a release, and its CHANGELOG's [Unreleased] items as of the last fetch.
 * Never a clock time for the next release: when to cut one is the person's
 * call (rule 6).
 */
import type { SessionCIStats, WorkRepo } from '@/lib/api'
import { boardOf, cadence, pipelineHref, repoState, type WorkItem } from '@/lib/work'

export interface NextReleaseProps {
  repos: readonly WorkRepo[]
  stats: ReadonlyMap<string, SessionCIStats | undefined>
  /** The board's rows: merged ones are listed per repository. */
  items: readonly WorkItem[]
  now: number
}

/** The repositories the strip speaks of: a tag, merged work, unreleased notes or commits, or a GitHub state to say. */
export function releaseRepos(repos: readonly WorkRepo[], items: readonly WorkItem[]): WorkRepo[] {
  return repos.filter((r) => r.tags?.last || r.unreleased?.count || r.ahead_of_tag || items.some((it) => it.stage === 'merged' && it.repo?.root === r.root))
}

export function NextRelease({ repos, stats, items, now }: NextReleaseProps) {
  const shown = releaseRepos(repos, items)
  const notes = repos.map((r) => [r, repoState(r, stats.get(r.root))] as const).filter(([r, s]) => s && (stats.has(r.root) || !r.remote))
  if (shown.length === 0 && notes.length === 0) return null
  return (
    <section data-work-next-release aria-label="Next release" className="grid min-w-0 gap-2">
      {shown.map((r) => {
        const st = stats.get(r.root)
        const c = cadence(r, boardOf(st)?.flow, now)
        const merged = items.filter((it) => it.stage === 'merged' && it.repo?.root === r.root)
        const u = r.unreleased
        return (
          <article key={r.root} data-work-release-repo={r.name} className="min-w-0 rounded-[var(--radius-panel)] border border-border bg-panel px-3 py-2.5 shadow-[var(--shadow-panel)]">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted">Next release</span>
              <span className="min-w-0 truncate text-[14px] font-semibold text-fg" title={r.root}>{r.name}</span>
              {c && <span data-work-cadence title={c.title} className="num min-w-0 text-[12.5px] text-fg-muted [overflow-wrap:anywhere]">{c.text}</span>}
              {r.ahead_of_tag ? <span className="num text-[12.5px] text-fg-muted" title="Commits on the default branch since the last tag">{r.ahead_of_tag} commit{r.ahead_of_tag === 1 ? '' : 's'} since the tag</span> : null}
            </div>
            {merged.length > 0 && (
              <div className="mt-1.5 min-w-0">
                <p className="text-[12px] text-fg-muted">Merged, waiting for a release</p>
                <ul className="mt-0.5 grid min-w-0 gap-0.5">
                  {merged.map((it) => (
                    <li key={it.key} className="flex min-w-0 items-baseline gap-2 text-[13px]">
                      <span className="num shrink-0 text-merged">#{it.pr?.number}</span>
                      {it.pr && it.repo
                        ? <a href={pipelineHref(it.repo.root, it.pr.number)} className="min-w-0 text-fg no-underline [overflow-wrap:anywhere] hover:text-accent">{it.title}</a>
                        : <span className="min-w-0 [overflow-wrap:anywhere]">{it.title}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {u && u.count > 0 && (
              <div data-work-unreleased className="mt-1.5 min-w-0">
                <p className="text-[12px] text-fg-muted" title="Read from the CHANGELOG on that ref in this checkout: what is on GitHub since your last fetch is not in it">
                  CHANGELOG [Unreleased] on <span className="mono">{u.ref}</span>, as of your last fetch
                </p>
                <ul className="mt-0.5 grid min-w-0 list-disc gap-0.5 pl-5 text-[13px] text-fg">
                  {u.items.map((t, i) => <li key={i} className="[overflow-wrap:anywhere]">{t}</li>)}
                </ul>
                {u.count > u.items.length && <p className="mt-0.5 pl-5 text-[12px] text-fg-muted">and {u.count - u.items.length} more</p>}
              </div>
            )}
          </article>
        )
      })}
      {notes.length > 0 && (
        <ul data-work-repo-notes className="grid min-w-0 gap-0.5 text-[12.5px] text-fg-muted">
          {notes.map(([r, s]) => <li key={r.root} className="[overflow-wrap:anywhere]"><span className="font-medium text-fg">{r.name}</span>: {s}</li>)}
        </ul>
      )}
    </section>
  )
}
