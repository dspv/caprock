/**
 * The Pipeline on Home (.ai/04-ui.md § CI/CD on Home): the first five of the
 * Pipeline's figures — in flight, needing a fix, ready, throughput, the CI
 * median — for the repository the Pipeline shows, at the head of Home's CI/CD
 * panel rather than as a second CI block beside it, with the way to the page
 * (owner, 2026-10-15, translated: "so that metrics from it can be
 * harmoniously put into the Dashboard").
 *
 * The same answer and tiles as the page: usePipelineStats (…/ci/stats, kept
 * per repository in lib/deckCache, so it draws the page's last answer at
 * once) and FlowFigures. It asks only while the CI/CD panel is unfolded and
 * Home is in front — the page itself is hidden then and asks nothing, so the
 * two never both poll.
 */
import { useContext, useMemo } from 'react'
import type { SessionSummary } from '@/lib/api'
import { asBoard } from '@/lib/prboard'
import { pickPipeline } from '@/lib/pipeline'
import { href } from '@/lib/router'
import { ScreenShown } from '@/lib/refresh'
import { usePipelineStats } from './PipelineView'
import { FlowFigures } from './PRBoard'

export function PipelineCard({ sessions }: { sessions: readonly SessionSummary[] }) {
  const shown = useContext(ScreenShown)
  const pick = useMemo(() => pickPipeline(sessions, {}), [sessions])
  const s = pick.session
  const [stats] = usePipelineStats(s?.session_id ?? '', s, shown)
  const board = useMemo(() => asBoard(stats?.board), [stats?.board])
  if (!pick.repo || !s || !board || stats?.reason || stats?.connected === false) return null
  return (
    <section data-pipeline-card aria-label="Pipeline" className="border-b border-border">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 pt-2.5">
        <span className="text-[13px] font-medium text-fg">Pipeline</span>
        <span className="mono min-w-0 truncate text-[12px] text-fg-muted" title={pick.repo.root}>{stats?.repo || pick.repo.name}</span>
        <a href={href({ name: 'pipeline', repo: pick.repo.root })} data-pipeline-open
          className="ml-auto shrink-0 text-[12px] font-medium text-accent no-underline hover:underline">Open Pipeline →</a>
      </div>
      <FlowFigures board={board} compact />
    </section>
  )
}
