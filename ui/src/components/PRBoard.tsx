/**
 * The PRs & CI tab's Board view (.ai/21-app.md § PRs & CI tab; owner,
 * 2026-10-14, translated: "I want to see something like a KANBAN: how tasks
 * come in, what stage they're in, maybe how many agents are working, even
 * some costs, and how they move through stages — essentially accounting of
 * releases and commits-PRs. That's the stat to watch.").
 *
 * The flow strip on top (throughput, the time a pull request takes from
 * opened to merged and from merged to released, the CI median, the agent
 * cost on the board), a column per stage, and the releases with what each
 * shipped and what the agents spent on it. A card opens the pull request in
 * the List view. Everything comes in the tab's one answer (…/ci/stats'
 * `board`): this view asks nothing of its own.
 */
import { useState, type ReactNode } from 'react'
import type { BranchPR } from '@/lib/branches'
import { AGENT_COST_NOTE, COLUMN_SHOWN, boardColumns, ciChip, costText, costTitle, perDay, type BoardItem, type BoardRelease, type ChipTone, type PRBoard, type Stage } from '@/lib/prboard'
import { spanText } from '@/lib/prstats'
import { fmtAgo } from '@/lib/format'
import { fmtRun } from '@/lib/ci'
import { openExternal } from '@/lib/nudges'
import { GitHubPerson } from './GitHubAvatar'

const STAGE_TONE: Record<Stage, string> = {
  draft: 'var(--color-fg-faint)', open: 'var(--color-warn)', fix: 'var(--color-danger)',
  ready: 'var(--color-ok)', merged: 'var(--color-merged)', released: 'var(--color-accent)',
}

const CHIP: Record<ChipTone, string> = {
  ok: 'border-ok/40 text-ok', fail: 'border-danger/45 bg-danger/10 text-danger', pending: 'border-warn/40 text-warn',
  muted: 'border-[var(--app-hairline)] text-fg-muted', faint: 'border-[var(--app-hairline)] text-fg-faint', merged: 'border-merged/45 text-merged',
}

export function PRBoardView({ board, prs, now, onOpen }: { board: PRBoard; prs: BranchPR[]; now: number; onOpen: (n: number) => void }) {
  const cols = boardColumns(board, prs)
  return (
    <div data-prs-board className="flex min-w-0 flex-col gap-3">
      <FlowStrip board={board} />
      <div className="app-scroll -mx-1 overflow-x-auto px-1 pb-1">
        <div className="grid min-w-[1020px] grid-cols-6 gap-2">
          {cols.map((c) => <Column key={c.stage.key} stage={c.stage.key} label={c.stage.label} note={c.stage.note} cards={c.cards} now={now} onOpen={onOpen} />)}
        </div>
      </div>
      <Releases releases={board.releases} prs={prs} now={now} onOpen={onOpen} />
    </div>
  )
}

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

function FlowStrip({ board }: { board: PRBoard }) {
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
      <Figure label="Agent cost on the board" value={`$${f.cost_usd.toFixed(2)}`} note="API list price" title={AGENT_COST_NOTE} />
    </section>
  )
}

// ---------------------------------------------------------------- the columns

function Column({ stage, label, note, cards, now, onOpen }: { stage: Stage; label: string; note: string; cards: BoardItem[]; now: number; onOpen: (n: number) => void }) {
  const [all, setAll] = useState(false)
  const shown = all ? cards : cards.slice(0, COLUMN_SHOWN)
  const cost = cards.reduce((t, c) => t + c.spend.cost_usd, 0)
  return (
    <section data-board-column={stage} aria-label={label} className="flex min-w-0 flex-col rounded-[var(--radius-panel)] border border-border bg-panel-2/40">
      <header title={note} className="flex items-baseline gap-2 border-b border-border px-2.5 pb-1.5 pt-2" style={{ boxShadow: `inset 0 2px 0 ${STAGE_TONE[stage]}` }}>
        <span className="truncate text-[11px] font-medium uppercase tracking-[0.1em] text-fg-muted">{label}</span>
        <span className="num text-[15px] font-semibold text-fg">{cards.length}</span>
        {cost > 0 && <span className="num ml-auto shrink-0 text-[11px] text-fg-faint" title={AGENT_COST_NOTE}>${cost >= 100 ? Math.round(cost) : cost.toFixed(2)}</span>}
      </header>
      <ul className="flex min-h-[64px] flex-col gap-1.5 p-1.5">
        {cards.length === 0 && <li className="px-1 py-2 text-[11.5px] text-fg-faint">Nothing here</li>}
        {shown.map((c) => <Card key={c.number} c={c} now={now} onOpen={() => onOpen(c.number)} />)}
        {cards.length > shown.length && (
          <li><button type="button" onClick={() => setAll(true)} className="w-full rounded-[6px] px-2 py-1 text-left text-[11.5px] text-fg-muted hover:bg-[var(--app-row-hover)] hover:text-fg">+{cards.length - shown.length} more</button></li>
        )}
      </ul>
    </section>
  )
}

function Card({ c, now, onOpen }: { c: BoardItem; now: number; onOpen: () => void }) {
  const chip = ciChip(c)
  const cost = costText(c.spend)
  const title = c.pr?.title ?? `#${c.number}`
  const since = c.stage_at ? spanText(Math.max(0, now - c.stage_at)) : ''
  return (
    <li>
      <button type="button" data-board-card={c.number} onClick={onOpen} title={`${title}\nOpen #${c.number} in the list`}
        className="flex w-full min-w-0 flex-col gap-1.5 rounded-[6px] border border-[var(--app-hairline)] bg-panel px-2 py-1.5 text-left shadow-[var(--shadow-panel)] hover:border-[var(--app-hairline-strong)] hover:bg-[var(--app-row-hover)]">
        <span className="line-clamp-2 text-[12.5px] leading-[1.35] text-fg">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-fg-muted">
          <span className="num shrink-0">#{c.number}</span>
          {c.pr?.author && <GitHubPerson login={c.pr.author} url={c.pr.author_avatar} size={14} className="min-w-0" />}
          {since && <span className="num ml-auto shrink-0 text-fg-faint" title={c.stage_at ? `In this stage since ${new Date(c.stage_at).toLocaleString()}` : undefined}>{since}</span>}
        </span>
        {(chip || c.release || cost || c.spend.live > 0) && (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
            {chip && <span data-board-ci={c.ci ?? 'unknown'} title={chip.title} className={`inline-flex h-[18px] items-center rounded-full border px-1.5 ${CHIP[chip.tone]}`}>{chip.text}</span>}
            {c.release && <span className="mono truncate text-accent" title={`Shipped in ${c.release}`}>{c.release}</span>}
            {c.spend.live > 0 && (
              <span data-board-live className="inline-flex items-center gap-1 text-ok" title={`${c.spend.live} agent session${c.spend.live === 1 ? '' : 's'} running on it now`}>
                <span aria-hidden className="inline-block h-[6px] w-[6px] rounded-full bg-ok" />{c.spend.live} {c.spend.live === 1 ? 'agent' : 'agents'}
              </span>
            )}
            {cost && <span data-board-cost className="num ml-auto shrink-0 text-fg-muted" title={costTitle(c.spend)}>{cost}</span>}
          </span>
        )}
      </button>
    </li>
  )
}

// ---------------------------------------------------------------- the releases

function Releases({ releases, prs, now, onOpen }: { releases: BoardRelease[]; prs: BranchPR[]; now: number; onOpen: (n: number) => void }) {
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
