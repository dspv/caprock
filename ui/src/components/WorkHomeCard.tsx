/**
 * The Work board on Home (.ai/04-ui.md § Work): its headline — "3 agents
 * live · 1 building · 2 on open PRs · 1 needs you" — and the first rows that
 * need the person or are working, with the way to the page. It reads only
 * `GET /v1/work` (lib/useWork.ts: on live frames, at most once a second,
 * nothing while Home is hidden), never the Pipeline answers, so its rows show
 * the pull requests recorded on the sessions. Draws nothing until there is a
 * live agent.
 */
import type { Work } from '@/lib/api'
import { useNow } from '@/lib/useNow'
import { buildWork, headline } from '@/lib/work'
import { useWork } from '@/lib/useWork'
import { StageBar, TitleLink } from './WorkRow'

const SHOWN = 3
const NO_STATS = new Map()

export function WorkHomeCard({ openHref = '#/work', onOpenSession }: { openHref?: string; onOpenSession?: (id: string) => void }) {
  const work = useWork()
  const now = useNow(15_000)
  if (!work.data) return null
  return <WorkHomeCardView work={work.data} now={now} openHref={openHref} onOpenSession={onOpenSession} />
}

export function WorkHomeCardView({ work, now, openHref = '#/work', onOpenSession }: { work: Work; now: number; openHref?: string; onOpenSession?: (id: string) => void }) {
  // Read defensively: a partial answer draws nothing rather than take Home down with it.
  if (!work.totals || !(work.totals.live > 0)) return null
  const board = buildWork(work, NO_STATS, now)
  const top = board.items.filter((it) => it.needsYou || it.working).slice(0, SHOWN)
  return (
    <section data-work-home aria-label="Work" className="min-w-0 rounded-[var(--radius-panel)] border border-border bg-panel shadow-[var(--shadow-panel)]">
      <div className={`flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 pt-2.5 ${top.length > 0 ? '' : 'pb-2.5'}`}>
        <span className="text-[13px] font-medium text-fg">Work</span>
        <span className="num min-w-0 text-[12px] text-fg-muted [overflow-wrap:anywhere]">{headline(board.counts)}</span>
        <a href={openHref} data-work-open-page className="ml-auto shrink-0 text-[12px] font-medium text-accent no-underline hover:underline">Open Work →</a>
      </div>
      {top.length > 0 && (
        <ul className="grid min-w-0 gap-1 px-3 pb-2.5 pt-1.5">
          {top.map((it) => (
            <li key={it.key} data-work-home-row={it.key} className="flex min-w-0 items-center gap-2 text-[13px]">
              <StageBar it={it} compact />
              <span className={`shrink-0 whitespace-nowrap text-[12px] ${it.needsYou ? 'font-medium text-warn' : 'text-fg-muted'}`}>{it.needsYou ? 'needs you' : it.word}</span>
              <TitleLink it={it} onOpenSession={onOpenSession} className="truncate font-normal" />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
