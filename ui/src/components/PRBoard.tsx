/**
 * The Pipeline page's flow strip and releases (.ai/04-ui.md § Pipeline;
 * owner, 2026-10-14, translated: "essentially accounting of releases and
 * commits-PRs. That's the stat to watch."): on top, how fast work flows —
 * throughput, opened → merged, merged → released (an estimate), the CI
 * median, the agent cost listed; below the list, each recent release with
 * the pull requests it shipped and what the agents spent on them. Both come
 * in the page's one answer (…/ci/stats' `board`): nothing here asks.
 */
import type { ReactNode } from 'react'
import type { BranchPR } from '@/lib/branches'
import { AGENT_COST_NOTE, perDay, type BoardRelease, type PRBoard } from '@/lib/prboard'
import { spanText } from '@/lib/prstats'
import { fmtAgo } from '@/lib/format'
import { fmtRun } from '@/lib/ci'
import { openExternal } from '@/lib/nudges'

// ---------------------------------------------------------------- the flow

function Figure({ label, value, note, title }: { label: string; value: ReactNode; note?: ReactNode; title?: string }) {
  return (
    <div data-board-figure={label} title={title} className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-[10.5px] uppercase tracking-[0.12em] text-fg-faint">{label}</span>
      <span className="num truncate text-[18px] font-semibold leading-tight text-fg">{value}</span>
      {note && <span className="truncate text-[11px] text-fg-muted">{note}</span>}
    </div>
  )
}

export function FlowStrip({ board }: { board: PRBoard }) {
  const f = board.flow
  const open = f.counts.draft + f.counts.open + f.counts.fix + f.counts.ready
  return (
    <section data-board-flow aria-label="How pull requests move" className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-6 gap-y-3 rounded-[var(--radius-panel)] border border-border bg-panel px-4 py-3 shadow-[var(--shadow-panel)]">
      <Figure label="In flight" value={open} note={`${f.counts.fix} need${f.counts.fix === 1 ? 's' : ''} a fix · ${f.counts.ready} ready`} title="Open pull requests among the newest listed: draft, CI running, needing a fix, ready" />
      <Figure label={`Throughput · ${f.days} days`} value={perDay(f.merged, f.days)} note={`${f.merged} merged`} title={`Pull requests merged in the last ${f.days} days, a day on average, from GitHub's merge stamps`} />
      <Figure label="Opened → merged" value={f.ttm_median_ms ? spanText(f.ttm_median_ms) : '–'} note={f.ttm_median_ms ? `median of ${f.ttm_count}` : 'fewer than two merges'}
        title="The median time from opened to merged of the pull requests merged in the window, GitHub's stamps" />
      <Figure label="Merged → released" value={f.release_lag_median_ms ? `~${spanText(f.release_lag_median_ms)}` : '–'} note={f.release_lag_median_ms ? `estimate · ${f.release_lag_count} released` : f.release_lag_count === 1 ? 'one release so far' : 'no release matched'}
        title="An estimate: each merge into the default branch is matched to the first release published after it, and the median taken of merge to publish" />
      <Figure label="CI" value={f.ci_median_ms ? fmtRun(f.ci_median_ms) : '–'} note={f.ci_median_ms ? 'median successful run' : 'fewer than two runs'} title="The busiest workflow's median successful run, start to finish, GitHub's run times" />
      <Figure label="Agent cost" value={`$${f.cost_usd.toFixed(2)}`} note="on the board · API list price" title={AGENT_COST_NOTE} />
    </section>
  )
}

// ---------------------------------------------------------------- the releases

export function Releases({ releases, prs, now, onOpen }: { releases: BoardRelease[]; prs: BranchPR[]; now: number; onOpen: (n: number) => void }) {
  const byNum = new Map(prs.map((p) => [p.number, p]))
  return (
    <section data-board-releases aria-label="Releases" className="rounded-[var(--radius-panel)] border border-border bg-panel shadow-[var(--shadow-panel)]">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border bg-panel-2/60 px-3 py-2">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted">Releases</h3>
        <span className="text-[11px] text-fg-faint" title={`Each merge into the default branch is matched to the first release published after it, from the newest listed pull requests. ${AGENT_COST_NOTE}`}>
          what each shipped, matched by merge time · agent cost at API list price
        </span>
      </header>
      {releases.length === 0 ? <p className="px-3 py-3 text-[12px] text-fg-faint">No published release read.</p> : (
        <ul>
          {releases.map((r) => (
            <li key={r.tag} data-board-release={r.tag} className="grid grid-cols-[minmax(120px,0.9fr)_minmax(0,3fr)_auto] items-start gap-x-4 border-b border-[var(--app-hairline)] px-3 py-2 last:border-b-0 @max-[760px]/prs:grid-cols-1">
              <div className="min-w-0">
                <button type="button" onClick={() => r.url && openExternal(r.url)} className="mono truncate text-[13px] font-semibold text-fg hover:underline" title={r.name ? `${r.name}\nOpen on GitHub` : 'Open on GitHub'}>{r.tag}</button>
                <div className="text-[11px] text-fg-faint" title={new Date(r.published_at).toLocaleString()}>
                  {fmtAgo(r.published_at, now)}{r.prerelease ? ' · pre-release' : ''}
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap gap-1">
                {r.prs.length === 0 ? <span className="text-[11.5px] text-fg-faint">{r.partial ? 'its merges are older than the pull requests listed' : 'no listed pull request merged for it'}</span>
                  : r.prs.map((n) => {
                    const p = byNum.get(n)
                    return (
                      <button key={n} type="button" onClick={() => onOpen(n)} title={p?.title ?? `#${n}`}
                        className="inline-flex max-w-[260px] items-center gap-1 rounded-full border border-[var(--app-hairline)] px-2 py-[1px] text-[11.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">
                        <span className="num shrink-0">#{n}</span><span className="truncate">{p?.title}</span>
                      </button>
                    )
                  })}
                {r.partial && r.prs.length > 0 && <span className="self-center text-[11px] text-fg-faint" title="The listed pull requests may not reach back to the release before it">· older merges may be missing</span>}
              </div>
              <div className="text-right">
                <div className="num text-[13px] font-semibold text-fg" title={AGENT_COST_NOTE}>{r.cost_usd > 0 ? `$${r.cost_usd.toFixed(2)}` : '–'}</div>
                <div className="text-[11px] text-fg-faint">{r.prs.length} PR{r.prs.length === 1 ? '' : 's'}{r.sessions ? ` · ${r.sessions} session${r.sessions === 1 ? '' : 's'}` : ''}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
