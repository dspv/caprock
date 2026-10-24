/**
 * The release plan (.ai/04-ui.md § Release plan; lib/releaseplan.ts): a
 * repository's next version as a heading — its hover says how it was
 * predicted — then a row per piece of work: its number and title, a bar of a
 * named segment per step filled to its step, the stage word, and as width
 * allows what it waits for, its age and its CI per OS; then what comes
 * later. The bars sit in one aligned column, as in the text report the owner
 * asked to see as a view (2026-10-15):
 *
 *   0.120.0
 *     #656 brain: agents → shared brain   ▓▓▓▓  merged  a release         5h
 *     #659 sidebar footer edge            ▓▓▓░  CI      CI on Windows · 6m  19h  ● ● ●
 *     Second Brain live build             ▓░░░  agent   the agent · 3 of 7  40m
 *
 * The bar ends at merged: a merge fills it (owner, 2026-10-20).
 *
 * The bar grows with the row (owner, 2026-10-16, translated: "a lot of empty
 * space wasted — make it bigger, or add some indicator"); the extra columns
 * drop off first as the container narrows (a container query), never a
 * sideways scroll.
 *
 * Drawn on the Pipeline page, in the right panel (`compact`), as the Work
 * page's Release view, and on the phone home (`phone`: components/
 * PhoneReleases). It reads nothing itself.
 *
 * The right panel (`compact`, ~320px) draws no bars and no columns (owner,
 * 2026-10-19, translated: the titles were unreadable, and only a pull
 * request's title, a branch and when it was pushed matter): each row is its
 * title over the full width, two lines at most, and under it one muted line,
 * *state · extra · age* (CompactRows).
 */
import { useContext, useMemo, useState, type ReactNode } from 'react'
import type { ReleaseCI, SessionCIStats } from '@/lib/api'
import { asBoard, type ShipsBy } from '@/lib/prboard'
import { releaseStatus, type ReleaseStatus } from '@/lib/releasestatus'
import { LastRelease, ReleaseInFlight, ReleaseStages, ReleaseWhy } from './ReleaseStatus'
import { ageText, BLOCKS, planEmpty, planForRepo, planSections, shownRows, type OSDot, type LinePart, type PlanRow, type ReleasePlanData, type Wait } from '@/lib/releaseplan'
import { api } from '@/lib/api'
import type { SessionBranches } from '@/lib/branches'
import { CI_IDLE_MS, usePoll } from '@/lib/usePoll'
import { changesRelease, useWork } from '@/lib/useWork'
import { useNow } from '@/lib/useNow'
import { pipelineHref, STEPS, titleIsNumber } from '@/lib/work'
import { SectionLabel, SessionSubagents, useFolded } from './Cockpit'
import { useDeckAnswer } from './CockpitCI'
import { Panel, usePanelFold } from './ui'
import { extTitle } from '@/lib/externalLinks'
import { PipelineHostContext } from '@/lib/pipelineHost'
import { href } from '@/lib/router'
import { openSession } from '@/lib/sessionJump'
import { TerminalIcon } from './AppIcons'

export interface ReleasePlanProps {
  plan: ReleasePlanData
  /** The right panel's size: smaller type, titles up to two lines. */
  compact?: boolean
  /** Name the repository beside the version (the Work page lists several). */
  showRepo?: boolean
  /** A pull request row opens this instead of the Pipeline's detail link (the Pipeline page opens it in place). */
  onOpen?: (number: number) => void
  /** Said when there is nothing to plan; absent, nothing is drawn. */
  empty?: ReactNode
  /**
   * The phone's size (390px): a row is a 44px tap target with its title on
   * one line and the bar and word under it, so every bar starts at the same
   * left edge whatever the title; a pull request row opens the pull request
   * on GitHub. Takes over `compact` and `onOpen`.
   */
  phone?: boolean
  /**
   * The release's own status (lib/releasestatus; the Pipeline page): its
   * bump and why beside the version, its stages as pills under it, a tag
   * already under way above it, and the last release under the rows.
   */
  status?: ReleaseStatus
  /** The clock the last release's age is said against; with `status`. */
  now?: number
}

export function ReleasePlan({ plan, compact = false, showRepo = false, onOpen, empty, phone = false, status, now = Date.now() }: ReleasePlanProps) {
  const nothing = plan.rows.length === 0 && plan.later.length === 0
  if (nothing && !plan.next && !empty) return null
  const merge = plan.ships === 'merge'
  // A release pull request names the version; else the rule's prediction.
  // The heading says the version or, with none, "Next release": the line's own
  // head word would repeat it ("Next release Next release · 1 merged").
  const pre = !merge && status?.phase === 'pre' ? status : undefined
  const v = pre?.version ?? plan.next?.version
  const steps = { ships: plan.ships, next: v }
  return (
    <section data-release-plan={plan.name} data-release-ships={plan.ships ?? ''} aria-label={`${plan.name}: ${merge ? 'work in flight' : 'next release'}`} className="grid min-w-0 gap-1.5">
      {!merge && status?.phase === 'tagged' && <ReleaseInFlight status={status} phone={phone} />}
      {merge ? (
        // No release to wait for: one line in place of the version (owner, 2026-10-18).
        <header className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span data-release-since title={plan.since?.title} className={`min-w-0 cursor-help text-fg-muted [overflow-wrap:anywhere] ${phone ? 'text-[14px]' : compact ? 'text-[11.5px]' : 'text-[12.5px]'}`}>{plan.since?.text}</span>
          {showRepo && <span className="min-w-0 truncate text-[13px] font-medium text-fg-muted" title={plan.root}>{plan.name}</span>}
        </header>
      ) : (
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h3 data-release-version={v ?? ''} title={pre?.why?.title ?? plan.next?.title ?? 'No changelog entries read for this repository, so no version is predicted.'}
          className={`num font-semibold text-fg ${phone ? 'text-[17px] tracking-[-0.01em]' : compact ? 'cursor-help text-[13px]' : 'cursor-help text-[16px] tracking-[-0.01em]'}`}>
          {v ?? 'Next release'}
        </h3>
        {v && <span className={`text-fg-faint ${compact && !phone ? 'text-[10.5px]' : 'text-[11px] uppercase tracking-[0.1em]'}`}>{compact && !phone ? 'next' : 'next release'}</span>}
        {pre && <ReleaseWhy status={pre} />}
        {showRepo && <span className="min-w-0 truncate text-[13px] font-medium text-fg-muted" title={plan.root}>{plan.name}</span>}
        {compact && !phone ? (plan.last && (
          // The right panel says only when the last release was; the sections below say the rest.
          <span data-release-since title={plan.since?.title} className="num min-w-0 truncate text-[11px] text-fg-muted">
            <span aria-hidden className="mr-1.5 text-fg-faint">·</span>last {plan.last.name} {ageText(now - plan.last.at)} ago
          </span>
        )) : plan.line ? <ReleaseLine parts={plan.line.filter((p) => p.key !== 'head')} since={plan.since} phone={phone} compact={compact} /> : plan.since && (
          <span data-release-since title={plan.since.title} className={`num min-w-0 text-fg-muted [overflow-wrap:anywhere] ${phone ? 'basis-full text-[12.5px]' : compact ? 'basis-full text-[11px]' : 'text-[12.5px]'}`}>{plan.since.text}</span>
        )}
      </header>
      )}
      {pre && <ReleaseStages status={pre} />}
      {nothing ? (
        <p className={`text-fg-muted ${phone ? 'text-[14px]' : compact ? 'text-[11.5px]' : 'text-[12.5px]'}`}>{merge ? 'No pull request open and no agent at work here.' : empty ?? 'Nothing waiting for a release.'}</p>
      ) : phone ? (
        <PhoneRows plan={plan} steps={steps} />
      ) : compact ? (
        <CompactRows plan={plan} onOpen={onOpen} />
      ) : (
        <Rows plan={plan} compact={compact} onOpen={onOpen} steps={steps} />
      )}
      {!merge && status?.last && <LastRelease last={status.last} now={now} />}
    </section>
  )
}

/** Scrolls to a section of this plan and marks it for a moment. */
function showSection(from: HTMLElement, key: string) {
  const el = from.closest('[data-release-plan]')?.querySelector<HTMLElement>(`[data-release-section="${key}"]`)
  if (!el) return
  el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  el.classList.add('text-fg')
  window.setTimeout(() => el.classList.remove('text-fg'), 1500)
}

/** The one release line: a part per fact, a click on one shows its section. Two lines at most on a phone. */
function ReleaseLine({ parts, since, phone, compact }: { parts: LinePart[]; since: ReleasePlanData['since']; phone: boolean; compact: boolean }) {
  return (
    <span data-release-since title={since?.title} className={`num flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-fg-muted ${phone ? 'basis-full text-[12.5px]' : compact ? 'basis-full text-[11px]' : 'text-[12.5px]'}`}>
      {parts.map((p, i) => (
        <span key={p.key} className="inline-flex min-w-0 items-baseline gap-x-1.5">
          {i > 0 && <span aria-hidden className="text-fg-faint">·</span>}
          {p.target
            ? <button type="button" data-line-part={p.key} title={p.title} onClick={(e) => showSection(e.currentTarget, p.target!)}
                className={`min-w-0 cursor-pointer truncate underline decoration-dotted underline-offset-2 hover:text-fg ${p.tone === 'danger' ? 'text-danger' : ''}`}>{p.text}</button>
            : <span data-line-part={p.key} title={p.title} className={`min-w-0 truncate ${p.key === 'head' ? 'font-medium text-fg' : ''}`}>{p.text}</span>}
        </span>
      ))}
    </span>
  )
}

/**
 * Every row, the next release's and later's, in one grid, so every bar and
 * column lines up whatever the title's length. The title and the bar share
 * the width the other columns leave (1.4 : 1, so the bar is never past ~40%
 * of the row; the cockpit's 2.2 : 1), and the columns beside the word come
 * in as the container widens — what it waits for at 520px, the agent cost
 * at 600px, CI per OS at 680px, the CI time at 760px, the age at 840px — so
 * a narrow panel drops the age first and what it waits for last. No column
 * gap: each cell after the title carries its own left padding, so a column
 * no row fills is zero wide.
 */
function Rows({ plan, compact, onOpen, steps }: { plan: ReleasePlanData; compact: boolean; onOpen?: (n: number) => void; steps: BarSteps }) {
  const size = compact ? 'text-[11px]' : 'text-[12px]'
  const [open, setOpen] = useState<{ all?: boolean; older?: boolean }>({})
  const row = (r: PlanRow) => r.stage === 'branch' ? (
    <li key={r.key} data-release-row={r.key} data-stage={r.stage} className="col-span-full min-w-0 py-[2px]">
      <BranchLine row={r} compact={compact} />
    </li>
  ) : (
    <li key={r.key} data-release-row={r.number ?? r.key} data-stage={r.stage} className="col-span-full grid min-w-0 grid-cols-subgrid items-center">
      <Title row={r} root={plan.root} compact={compact} onOpen={onOpen} />
      <span className="min-w-0 pl-3"><Blocks row={r} compact={compact} {...steps} /></span>
      <Word row={r} className={`whitespace-nowrap pl-3 ${size}`} />
      <span data-release-col="wait" className="hidden min-w-0 @[520px]/plan:block">{r.wait && <WaitFor wait={r.wait} compact={compact} />}</span>
      <span data-release-col="citime" className="hidden @[760px]/plan:block">
        {r.ciTime && <span data-release-citime title={r.ciTime.title} className={`num block whitespace-nowrap pl-3 text-right ${size} ${r.ciTime.tone === 'warn' ? 'text-warn' : 'text-fg-muted'}`}>{r.ciTime.text}</span>}
      </span>
      <span data-release-col="ci" className="hidden @[680px]/plan:block">{r.ci && <OSDots dots={r.ci} />}</span>
      <span data-release-col="cost" className="hidden @[600px]/plan:block">
        <span data-release-cost title={r.cost.title} className={`num block whitespace-nowrap pl-3 text-right ${size} ${r.cost.known ? 'text-fg-muted' : 'text-fg-faint'}`}>{r.cost.text}</span>
      </span>
      <span data-release-col="age" className="hidden @[840px]/plan:block">
        {r.age && <span data-release-age title={r.age.title} className={`num block whitespace-nowrap pl-3 text-right text-fg-faint ${size}`}>{r.age.text}</span>}
      </span>
    </li>
  )
  return (
    <div className="@container/plan min-w-0">
      <ul data-release-rows className={`grid min-w-0 items-center ${compact
        ? 'grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_auto] gap-y-[3px] text-[12px] @[520px]/plan:grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_repeat(2,auto)] @[600px]/plan:grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_repeat(3,auto)] @[680px]/plan:grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_repeat(4,auto)] @[760px]/plan:grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_repeat(5,auto)] @[840px]/plan:grid-cols-[minmax(0,2.2fr)_minmax(60px,1fr)_repeat(6,auto)]'
        : 'grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_auto] gap-y-1 text-[13px] @[520px]/plan:grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_repeat(2,auto)] @[600px]/plan:grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_repeat(3,auto)] @[680px]/plan:grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_repeat(4,auto)] @[760px]/plan:grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_repeat(5,auto)] @[840px]/plan:grid-cols-[minmax(0,1.4fr)_minmax(88px,1fr)_repeat(6,auto)]'}`}>
        {planSections(plan.rows).map((sec, i) => {
          const shown = shownRows(sec.key, sec.rows, open)
          return [
            <li key={`section:${sec.key}`} data-release-section={sec.key}
              className={`col-span-full font-medium text-fg-faint ${i > 0 ? 'pt-1.5' : ''} ${compact ? 'text-[10.5px]' : 'text-[11.5px]'}`}>
              {sec.label}<span data-release-hint className="block font-normal text-fg-faint/80">{sec.hint}</span>
            </li>,
            ...shown.rows.map(row),
            (shown.more > 0 || shown.old > 0) && (
              <li key={`more:${sec.key}`} className={`col-span-full ${compact ? 'text-[10.5px]' : 'text-[11.5px]'}`}>
                <MoreRows shown={shown} onAll={() => setOpen((o) => ({ ...o, all: true }))} onOlder={() => setOpen((o) => ({ ...o, older: true }))} />
              </li>
            ),
          ]
        })}
        {plan.later.map((g) => [
          <li key={`later:${g.key}`} data-release-later={g.key}
            className={`col-span-full pt-1.5 font-medium text-fg-faint ${compact ? 'text-[10.5px]' : 'text-[11.5px]'}`}>
            {g.label}
          </li>,
          ...g.rows.map(row),
        ])}
      </ul>
    </div>
  )
}

/** The right panel's open pull requests: blocked first, then under way, then ready; the board's order within each. */
export function byUrgency(rows: readonly PlanRow[]): PlanRow[] {
  return rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => a.state.rank - b.state.rank || i - j).map(([r]) => r)
}

/** The right panel's pushed branches, folded until asked for, remembered per viewer. */
const BRANCHES_FOLD = 'release-branches-shown'

/**
 * The right panel's rows (owner, 2026-10-19): sections in capitals with
 * their counts — *Shipping*, *Open PRs*, *Branches without a PR*, *Agents
 * working* — each row its title over the full width, two lines at most, and
 * one muted line under it: the state in plain words, what else is said (the
 * branches a batch PR carries, what an agent does) and the age. A blocked
 * pull request is marked *!*. The branches fold to their heading until
 * asked, one line each: the name and the age.
 */
function CompactRows({ plan, onOpen }: { plan: ReleasePlanData; onOpen?: (n: number) => void }) {
  const [open, setOpen] = useState<{ all?: boolean; older?: boolean }>({})
  // usePanelFold keeps the keys a viewer folded; here the key's presence means shown, so the default is folded.
  const [folded, toggle] = usePanelFold(BRANCHES_FOLD)
  const shownBranches = !folded
  const head = 'text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint'
  return (
    <div data-release-rows data-release-compact className="grid min-w-0 gap-2 text-[12px]">
      {planSections(plan.rows).map((sec) => {
        if (sec.key === 'branch') {
          const shown = shownRows(sec.key, sec.rows, open)
          return (
            <div key={sec.key} className="grid min-w-0 gap-0.5">
              <button type="button" data-release-section={sec.key} aria-expanded={shownBranches} onClick={toggle} title={sec.hint}
                className={`flex min-w-0 cursor-pointer items-center justify-between gap-2 text-left hover:text-fg-muted ${head}`}>
                <span className="min-w-0 truncate">{sec.short}</span>
                <span aria-hidden className={`shrink-0 text-[11px] leading-none transition-transform ${shownBranches ? 'rotate-90' : ''}`}>▸</span>
              </button>
              {shownBranches && (
                <ul className="grid min-w-0">
                  {shown.rows.map((r) => <CompactBranch key={r.key} row={r} />)}
                  {(shown.more > 0 || shown.old > 0) && (
                    <li className="text-[10.5px]"><MoreRows shown={shown} onAll={() => setOpen((o) => ({ ...o, all: true }))} onOlder={() => setOpen((o) => ({ ...o, older: true }))} /></li>
                  )}
                </ul>
              )}
            </div>
          )
        }
        const rows = sec.key === 'pr' ? byUrgency(sec.rows) : sec.rows
        return (
          <div key={sec.key} className="grid min-w-0 gap-1">
            <h5 data-release-section={sec.key} title={sec.hint} className={head}>{sec.short}</h5>
            <ul className="grid min-w-0 gap-1.5">
              {rows.map((r) => <CompactRow key={r.key} row={r} root={plan.root} onOpen={onOpen} mark={sec.key === 'pr'} />)}
            </ul>
          </div>
        )
      })}
      {plan.later.map((g) => (
        <div key={g.key} className="grid min-w-0 gap-1">
          <h5 data-release-later={g.key} className={head}>{g.label}</h5>
          <ul className="grid min-w-0 gap-1.5">
            {g.rows.map((r) => <CompactRow key={r.key} row={r} root={plan.root} onOpen={onOpen} />)}
          </ul>
        </div>
      ))}
    </div>
  )
}

/**
 * One right-panel row: a blocked mark where the section has them, the title
 * (Title, two lines at most), then *state · +N branches · age*. *+N
 * branches* opens the names of the pushed branches the pull request carries.
 */
function CompactRow({ row: r, root, onOpen, mark = false }: { row: PlanRow; root: string; onOpen?: (n: number) => void; mark?: boolean }) {
  const [names, setNames] = useState(false)
  const st = r.state
  const age = st.age ?? r.age
  // A subagent's word already says how long it has worked.
  const sayAge = age && !st.text.endsWith(age.text)
  const extra = !r.number && r.wait && r.wait.text !== st.text ? r.wait : undefined
  const dot = <span aria-hidden className="shrink-0 text-fg-faint">·</span>
  return (
    <li data-release-row={r.number ?? r.key} data-stage={r.stage} data-release-rank={st.rank} className="flex min-w-0 gap-1">
      {mark && (
        <span data-release-blocked={st.rank === 0 ? '' : undefined} aria-hidden className={`w-2 shrink-0 text-center font-bold leading-[1.35] ${st.tone === 'warn' ? 'text-warn' : 'text-danger'}`}>{st.rank === 0 ? '!' : ''}</span>
      )}
      <div className="grid min-w-0 flex-1 gap-px leading-[1.35]">
        <Title row={r} root={root} compact onOpen={onOpen} />
        <span data-release-meta className="flex min-w-0 items-baseline gap-1 text-[10.5px] text-fg-faint">
          <span data-release-state title={st.title}
            className={`shrink-0 whitespace-nowrap ${st.tone === 'danger' ? 'font-medium text-danger' : st.tone === 'warn' ? 'font-medium text-warn' : r.stage === 'merged' ? 'text-merged' : 'text-fg-muted'}`}>{st.text}</span>
          {r.carried?.length ? <>{dot}<button type="button" data-release-carried aria-expanded={names} onClick={() => setNames((v) => !v)}
            title={`Pushed branches this pull request already carries: ${r.carried.join(', ')}`}
            className="shrink-0 cursor-pointer whitespace-nowrap underline decoration-dotted underline-offset-2 hover:text-fg">+{r.carried.length} branch{r.carried.length === 1 ? '' : 'es'}</button></> : null}
          {extra && <>{dot}<span data-release-wait title={extra.title} className={`min-w-0 truncate ${extra.tone === 'warn' ? 'text-warn' : extra.tone === 'danger' ? 'text-danger' : ''}`}>{extra.text}</span></>}
          {sayAge && <>{dot}<span data-release-age title={age.title} className="num shrink-0 whitespace-nowrap">{age.text}</span></>}
        </span>
        {names && r.carried && (
          <ul data-release-carried-names className="grid min-w-0 text-[10.5px] text-fg-faint">
            {r.carried.map((n) => <li key={n} className="truncate" title={n}>{n}</li>)}
          </ul>
        )}
      </div>
    </li>
  )
}

/** A pushed branch in the right panel, one line: its name (cut), its age at the right; the row opens the comparison on GitHub. */
function CompactBranch({ row: r }: { row: PlanRow }) {
  const body = (
    <>
      <span data-release-branch className="min-w-0 truncate">{r.branch}</span>
      {r.age && <span data-release-age className="num shrink-0 text-[10.5px] text-fg-faint">{r.age.text}</span>}
    </>
  )
  const title = `${r.title !== r.branch ? `${r.title}\n` : ''}${r.wordTitle ?? ''}`
  const cls = 'flex min-w-0 items-baseline justify-between gap-2 rounded-[3px] py-px text-fg-muted no-underline hover:text-accent'
  return (
    <li data-release-row={r.key} data-stage={r.stage} className="min-w-0">
      {r.url
        ? <a href={r.url} target="_blank" rel="noopener noreferrer" data-ext="none" title={extTitle(title)} className={cls}>{body}</a>
        : <div title={title} className={cls}>{body}</div>}
    </li>
  )
}

/** What a row waits for now, cut to its column; the whole of it and where it comes from on hover. */
function WaitFor({ wait: w, compact }: { wait: Wait; compact: boolean }) {
  return (
    <span data-release-wait title={w.title}
      className={`block max-w-[18rem] truncate pl-3 ${compact ? 'text-[11px]' : 'text-[12px]'} ${w.tone === 'danger' ? 'text-danger' : w.tone === 'warn' ? 'text-warn' : 'text-fg-muted'}`}>
      {w.text}
    </span>
  )
}

const DOT_TONE: Record<OSDot['state'], string> = { pass: 'bg-ok', fail: 'bg-danger', running: 'bg-accent release-step-pulse' }

/** A dot per OS its checks ran on, macOS · Linux · Windows, each named on hover. */
function OSDots({ dots }: { dots: OSDot[] }) {
  return (
    <span data-release-ci role="img" aria-label={`CI: ${dots.map((d) => d.title).join('; ')}`} className="flex items-center gap-[5px] pl-3">
      {dots.map((d) => <span key={d.os} data-os={d.os} data-os-state={d.state} title={d.title} className={`h-[7px] w-[7px] rounded-full ${DOT_TONE[d.state]}`} />)}
    </span>
  )
}

/**
 * The phone's rows: one per piece of work, its title on the first line (cut,
 * the whole of it on the second line's hover) and the bar, the stage word
 * and what it waits for (cut) on the second, so the bars stand in one column
 * at the left edge at any width. A pull request row is a link to it on GitHub, the whole row its target; an agent's row, a link into its session's chat.
 */
function PhoneRows({ plan, steps }: { plan: ReleasePlanData; steps: BarSteps }) {
  const [open, setOpen] = useState<{ all?: boolean; older?: boolean }>({})
  const row = (r: PlanRow) => {
    if (r.stage === 'branch') {
      return (
        <li key={r.key} data-release-row={r.key} data-stage={r.stage} className="min-w-0 border-b border-border px-3 py-2 last:border-b-0">
          <BranchLine row={r} phone />
        </li>
      )
    }
    const body = (
      <>
        <span className="flex min-w-0 items-baseline text-[14px] leading-[1.3]">
          {r.number && !titleIsNumber(r.number, r.title) ? <span className="num mr-1.5 shrink-0 text-fg-muted">#{r.number}</span> : null}
          <span className="min-w-0 truncate text-fg">{r.title}</span>
        </span>
        {r.branch && <span data-release-branch title={r.branch} className="min-w-0 truncate text-[12px] text-fg-faint">{r.branch}</span>}
        <span className="flex min-w-0 items-center gap-2.5">
          <Blocks row={r} phone {...steps} />
          <Word row={r} className="shrink-0 whitespace-nowrap text-[12.5px]" />
          {r.wait && <span data-release-wait title={r.wait.title} className={`min-w-0 truncate text-[12.5px] ${r.wait.tone === 'danger' ? 'text-danger' : r.wait.tone === 'warn' ? 'text-warn' : 'text-fg-faint'}`}>{r.wait.text}</span>}
        </span>
      </>
    )
    const cls = 'grid min-h-11 min-w-0 content-center gap-1 px-3 py-2'
    // An agent's row opens its session the way the phone opens one: its chat (owner, 2026-10-17).
    return (
      <li key={r.key} data-release-row={r.number ?? r.key} data-stage={r.stage} className="min-w-0 border-b border-border last:border-b-0">
        {r.url
          ? <a href={r.url} target="_blank" rel="noopener noreferrer" title={extTitle(r.title)} className={`${cls} text-fg no-underline active:bg-panel-2`}>{body}</a>
          : r.session
            ? <a href={href({ name: 'session', id: r.session.id, tab: 'chat' })} data-release-session={r.session.id} title={`Open the session: ${r.title}`} className={`${cls} text-fg no-underline active:bg-panel-2`}>{body}</a>
            : <div title={r.title} className={cls}>{body}</div>}
      </li>
    )
  }
  return (
    <ul data-release-phone className="-mx-3 min-w-0 border-t border-border">
      {planSections(plan.rows).map((sec) => {
        const shown = shownRows(sec.key, sec.rows, open)
        return [
          <li key={`section:${sec.key}`} data-release-section={sec.key}
            className="border-b border-border px-3 pb-1.5 pt-3 text-[12px] font-medium text-fg-faint">
            {sec.label}<span data-release-hint className="block text-[11.5px] font-normal">{sec.hint}</span>
          </li>,
          ...shown.rows.map(row),
          (shown.more > 0 || shown.old > 0) && (
            <li key={`more:${sec.key}`} className="border-b border-border px-3 py-2 text-[13px]">
              <MoreRows shown={shown} onAll={() => setOpen((o) => ({ ...o, all: true }))} onOlder={() => setOpen((o) => ({ ...o, older: true }))} />
            </li>
          ),
        ]
      })}
      {plan.later.map((g) => [
        <li key={`later:${g.key}`} data-release-later={g.key}
          className="border-b border-border px-3 pb-1.5 pt-3 text-[12px] font-medium text-fg-faint last:border-b-0">
          {g.label}
        </li>,
        ...g.rows.map(row),
      ])}
    </ul>
  )
}

/**
 * A pushed branch, in two lines that a 360px panel can read (owner,
 * 2026-10-19, translated: "the information isn't perceivable like this; I
 * don't even know what to do with it"): its last commit's subject, up to two
 * lines and never cut to a few letters, then, muted, the branch's name (cut
 * first), the commits ahead and the age, the agent cost when one is known,
 * and ↗ at the end of that line — the whole row opens the comparison on
 * GitHub. No *branch* chip: the section's heading says so.
 */
function BranchLine({ row: r, compact = false, phone = false }: { row: PlanRow; compact?: boolean; phone?: boolean }) {
  const meta = phone ? 'text-[12px]' : compact ? 'text-[10.5px]' : 'text-[11.5px]'
  const body = (
    <>
      <span data-release-title className={`line-clamp-2 text-fg [overflow-wrap:anywhere] ${phone ? 'text-[14px] leading-[1.3]' : ''}`}>{r.title}</span>
      <span className={`flex min-w-0 items-baseline gap-1 text-fg-faint ${meta}`}>
        <span data-release-branch title={r.branch} className="min-w-0 truncate">{r.branch}</span>
        <span aria-hidden className="shrink-0">·</span>
        <span data-release-word title={r.wordTitle} className="shrink-0 whitespace-nowrap">{r.word}</span>
        {r.cost.known && <><span aria-hidden className="shrink-0">·</span><span data-release-cost title={r.cost.title} className="num shrink-0 whitespace-nowrap">{r.cost.text}</span></>}
        {r.url && <span aria-hidden className="shrink-0">↗</span>}
      </span>
    </>
  )
  const cls = 'grid min-w-0 gap-px text-left no-underline'
  return r.url
    ? <a href={r.url} target="_blank" rel="noopener noreferrer" data-ext="none" title={extTitle(`${r.title} — ${r.branch} on GitHub`)} className={`${cls} hover:[&>span:first-child]:text-accent`}>{body}</a>
    : <div title={r.title} className={cls}>{body}</div>
}

/** The quiet links under a section that holds rows back: *Show all N*, *+N older*. */
function MoreRows({ shown, onAll, onOlder }: { shown: { total: number; more: number; old: number }; onAll: () => void; onOlder: () => void }) {
  const link = 'cursor-pointer underline decoration-dotted underline-offset-2 hover:text-fg'
  return (
    <span className="flex flex-wrap gap-x-3 text-fg-faint">
      {shown.more > 0 && <button type="button" data-release-more onClick={onAll} className={`${link} text-fg-muted`}>Show all {shown.total}</button>}
      {shown.old > 0 && <button type="button" data-release-older onClick={onOlder} title="Pushed branches with no commit in the last 7 days" className={link}>+{shown.old} older</button>}
    </span>
  )
}

/** The stage word, in the colour its step is drawn in. */
function Word({ row: r, className }: { row: PlanRow; className: string }) {
  return (
    <span data-release-word title={r.wordTitle}
      className={`${className} ${r.red ? 'font-medium text-danger' : r.warn ? 'font-medium text-warn' : r.stage === 'merged' ? 'text-merged' : 'text-fg-muted'}`}>
      {r.word}
    </span>
  )
}

/**
 * A row's title. A pull request's opens it (on the Pipeline page, in place);
 * when an agent session is known on it, a small terminal button after the
 * title opens that session. An agent's row with no pull request is itself
 * the way into its session (owner, 2026-10-17, translated: "from here I want
 * to go into the session"): the title is the button. Either goes as a
 * *Waiting for you* row does (lib/sessionJump openSession): the session's
 * tab in the desktop app, its terminal or timeline in a browser.
 */
function Title({ row: r, root, compact, onOpen }: { row: PlanRow; root: string; compact: boolean; onOpen?: (n: number) => void }) {
  const host = useContext(PipelineHostContext)
  const s = r.session
  const go = s ? () => openSession(host.onOpenSession, s.id, s.owned) : undefined
  const text = (
    <>
      {r.number && !titleIsNumber(r.number, r.title) ? <span className="num mr-1.5 text-fg-muted">#{r.number}</span> : null}
      <span className="text-fg">{r.title}</span>
      {r.branch ? <span data-release-branch title={r.branch} className="block max-w-full truncate text-[0.85em] text-fg-faint">{r.branch}</span> : null}
    </>
  )
  // Two lines in the right panel, never a title cut to a few letters (owner, 2026-10-19).
  const wrap = compact ? 'line-clamp-2 [overflow-wrap:anywhere]' : '[overflow-wrap:anywhere]'
  const cls = `min-w-0 text-left no-underline hover:[&>span:last-child]:text-accent ${wrap}`
  if (!r.number) {
    if (go) {
      return (
        <button type="button" data-release-session={s!.id} onClick={go} title={`Open the session: ${r.title}`}
          aria-label={`Open the session: ${r.title}`}
          className={`${cls} rounded-[3px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent`}>{text}</button>
      )
    }
    // A pushed branch opens its comparison with the default branch on GitHub.
    if (r.url) return <a href={r.url} target="_blank" rel="noopener noreferrer" title={extTitle(r.title)} className={cls}>{text}</a>
    return <span className={`min-w-0 ${wrap}`} title={r.title}>{text}</span>
  }
  const link = onOpen
    ? <button type="button" onClick={() => onOpen(r.number!)} title={r.title} className={cls}>{text}</button>
    : <a href={pipelineHref(root, r.number)} title={r.title} className={cls}>{text}</a>
  if (!go) return link
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {link}
      <button type="button" data-release-session={s!.id} onClick={go}
        title={`Open session: ${s!.name}`} aria-label={`Open session: ${s!.name}`}
        className="inline-flex shrink-0 items-center justify-center rounded-[4px] p-0.5 text-fg-faint hover:bg-panel-2 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent">
        <TerminalIcon size={compact ? 12 : 13} />
      </button>
    </span>
  )
}

type BarStep = (typeof STEPS)[number]
const STEP_NAME: Record<BarStep, string> = { agent: 'Agent', PR: 'Pull request', CI: 'CI', merged: 'Merged' }
const STEP_SAYS: Record<StepState, string> = { done: 'done', now: 'under way', red: 'failed', warn: 'waits on you', off: 'to come' }
export type StepState = 'done' | 'now' | 'red' | 'warn' | 'off'

/** How a repository's bars are told on hover: how it ships, and the next version a merge waits for. */
export interface BarSteps {
  ships?: ShipsBy
  next?: string
}

/**
 * Each step's state on a row's bar: done up to the one it is on, that one
 * red, amber or under way when it is. A merge is the last step, so a merged
 * row's bar is full.
 */
export function stepStates(r: Pick<PlanRow, 'filled' | 'red' | 'warn' | 'running'>): StepState[] {
  const on = Math.round(r.filled / (BLOCKS / STEPS.length))
  return STEPS.map((_, i) => {
    if (i >= on) return 'off'
    if (i < on - 1) return 'done'
    return r.red ? 'red' : r.warn ? 'warn' : r.running ? 'now' : 'done'
  })
}

/**
 * A segment per step (agent, PR, CI, merged), each named on hover: filled to
 * the step it is on, that step red when it failed, amber when a landing
 * label waits on the person, pulsing softly while it is under way (CI
 * running, an agent at work); merged rows full, in the merged colour. The
 * bar ends at merged (owner, 2026-10-20, translated: the final status should
 * be merged — a grey released block read as unfinished, or closed); whether
 * a merge is released is a word after it, never a block. On a page it fills
 * its column, so it grows with the row; on the phone it is a fixed width.
 */
export function Blocks({ row: r, compact = false, phone = false, ships, next }: { row: PlanRow; compact?: boolean; phone?: boolean } & BarSteps) {
  if (r.stage === 'branch') return null
  const states = stepStates(r)
  const path = STEPS.map((s) => (s === 'PR' ? 'PR' : s === 'CI' ? 'CI' : s[0]!.toUpperCase() + s.slice(1))).join(' → ')
  const tone = r.stage === 'merged' || r.stage === 'released' ? 'bg-merged' : 'bg-accent'
  const on = states.filter((s) => s !== 'off').length
  return (
    <span data-release-bar role="img" aria-label={`${on} of ${STEPS.length} steps (${path}): ${r.word}`}
      className={`flex items-center gap-[3px] ${phone ? 'shrink-0' : 'w-full'}`}>
      {STEPS.map((step, i) => {
        const s = states[i]!
        const color = s === 'off' ? 'bg-border-strong' : s === 'red' ? 'bg-danger' : s === 'warn' ? 'bg-warn' : tone
        const says = step === 'PR' && s === 'off' && !r.number ? 'none yet — the agent has not opened one'
          : step === 'merged' && s === 'done' && r.stage === 'merged' && ships === 'release' ? `done — not released yet, it ships with the next release${next ? ` (v${next})` : ''}`
            : STEP_SAYS[s]
        return <span key={step} data-step={step} data-step-state={s} title={`${STEP_NAME[step]}: ${says}${s === 'off' || s === 'done' ? '' : ` — ${r.word}`}\n${path}`}
          className={`${phone ? 'h-[10px] w-[20px]' : compact ? 'h-[7px] min-w-[8px] flex-1' : 'h-[9px] min-w-[12px] flex-1'} rounded-[2px] ${color}${s === 'now' ? ' release-step-pulse' : ''}`} />
      })}
    </span>
  )
}

/**
 * The Pipeline page's *Next release* panel, under Flow: the repository on
 * the page, from the page's own Pipeline answer and the Work answer (read
 * while the page is in front, again on GitHub news only). A row opens its
 * pull request beside the list, as the list's rows do.
 */
export function PipelineRelease({ root, stats, run, visible, now, onOpen }: { root: string; stats?: SessionCIStats; run?: ReleaseCI; visible: boolean; now: number; onOpen?: (n: number) => void }) {
  const work = useWork({ on: visible, changes: changesRelease })
  const plan = useMemo(() => planForRepo(work.data, root, stats, now), [work.data, root, stats, now])
  const repo = work.data?.repos?.find((r) => r.root === root)
  const ref = repo?.unreleased?.ref
  const status = useMemo(() => {
    const board = asBoard(stats?.board)
    return releaseStatus({
      lastTag: repo?.tags?.last, unreleased: repo?.unreleased, merged: plan.rows.filter((r) => r.stage === 'merged').length,
      prs: stats?.prs ?? [], cards: board?.cards, releases: board?.releases ?? [], run,
    })
  }, [repo, plan.rows, stats, run])
  return (
    // Where work ships on merge there is no next release to name the panel after.
    <Panel title={plan.ships === 'merge' ? 'In flight' : 'Next release'} fold="pipeline-next-release"
      right={<span title="Pull requests from GitHub; agents, tags and changelog entries from this machine, as of your last fetch">{ref ? `changelog on ${ref}` : 'this machine'}</span>}>
      <div data-pipeline-release className="px-3 py-2.5">
        <ReleasePlan plan={plan} onOpen={onOpen} status={status} now={now} empty="Nothing merged since the last tag, no pull request open and no agent at work here." />
      </div>
    </Panel>
  )
}

/**
 * The right panel's *Release* section: the session's repository's next
 * release, compact. It asks GitHub nothing: it draws the Pipeline answer the
 * CI section, the Pipeline page or the Work page last read for that
 * repository (lib/deckCache), and the Work answer, read while the section is
 * unfolded and again only on GitHub news (changesRelease) — never on every
 * turn of the agent beside it. Folded, the version and the count are its line.
 */
export function CockpitRelease({ sessionId, repoRoot }: { sessionId: string; repoRoot?: string }) {
  const folded = useFolded()
  const stats = useDeckAnswer<SessionCIStats>(`stats:${repoRoot || sessionId}`)
  const work = useWork({ on: !folded && !!repoRoot, changes: changesRelease })
  // The pushed branches with no pull request: the deck's Branches answer
  // (local git, kept by the daemon), read unfolded, once a minute.
  const [branches] = usePoll<SessionBranches>(!folded && !!repoRoot, `release-branches:${sessionId}`, () => api.sessionBranches(sessionId), () => false, CI_IDLE_MS, `branches:${repoRoot || sessionId}`)
  const subagents = useContext(SessionSubagents)
  const now = useNow(60_000)
  const plan = useMemo(() => (repoRoot ? planForRepo(work.data, repoRoot, stats.d, now, { branches, subagents }) : undefined), [work.data, repoRoot, stats.d, now, branches, subagents])
  if (!plan || (!folded && planEmpty(plan))) return null
  const n = plan.rows.length
  return (
    <section aria-label="Release" data-cockpit-release className="grid gap-2">
      <SectionLabel right={folded && (
        <span data-fold-only className="num flex min-w-0 items-baseline gap-1.5 text-fg-muted">
          {plan.next?.version && <span className="font-medium text-fg">{plan.next.version}</span>}
          <span>{n} in work</span>
        </span>
      )}>Release</SectionLabel>
      <ReleasePlan plan={plan} compact now={now} />
    </section>
  )
}
