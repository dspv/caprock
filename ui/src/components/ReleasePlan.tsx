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
import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ReleaseCI, SessionCIStats, SessionRepoCI, Work, WorkEntry, WorkRepo } from '@/lib/api'
import { asBoard, type ShipsBy } from '@/lib/prboard'
import { mainChecks, nextHint, OUT_RECENT_MS, prKind, releaseFold, releaseStatus, STATUS_TEXT, tagUnpublished, type BatchPR, type NextHint, type ReleaseStatus } from '@/lib/releasestatus'
import { batchOf, groupNotes, notesHeading, notesOf, notInIt, viaLine, type NotesHeading, type NotInIt, type ViaLine } from '@/lib/releasenotes'
import { stageWords, stripStages } from '@/lib/releasestatus'
import { LastRelease, ReleaseInFlight, ReleaseStages, ReleaseStrip, ReleaseWhy } from './ReleaseStatus'
import { ageText, BLOCKS, onMaster, planForRepo, planSections, shownRows, type OSDot, type OSSquare, type LinePart, type PlanRow, type ReleasePlanData, type Wait } from '@/lib/releaseplan'
import { api } from '@/lib/api'
import type { SessionBranches } from '@/lib/branches'
import { CI_IDLE_MS, CI_RUNNING_MS, usePoll } from '@/lib/usePoll'
import { changesRelease, useWork } from '@/lib/useWork'
import { useNow } from '@/lib/useNow'
import { pipelineHref, STEPS, titleIsNumber } from '@/lib/work'
import { SectionLabel, useFolded } from './Cockpit'
import { asOfText, KEPT_CLASS, useDeckAnswer, useKeptCopy } from './CockpitCI'
import { workRepoKey, writeDeck } from '@/lib/deckCache'
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
  // The right panel draws the release's stages as one compact strip at the
  // top (owner, 2026-11-18), not the Pipeline's pills.
  const strip = compact && !phone
  return (
    <section data-release-plan={plan.name} data-release-ships={plan.ships ?? ''} aria-label={`${plan.name}: ${merge ? 'work in flight' : 'next release'}`} className="grid min-w-0 gap-1.5">
      {strip && !merge && status && status.phase !== 'idle' && <ReleaseStrip status={status} version={status.phase === 'tagged'} />}
      {!strip && !merge && status?.phase === 'tagged' && <ReleaseInFlight status={status} phone={phone} />}
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
      {pre && !strip && <ReleaseStages status={pre} />}
      {nothing ? (
        <p className={`text-fg-muted ${phone ? 'text-[14px]' : compact ? 'text-[11.5px]' : 'text-[12.5px]'}`}>{merge ? 'No pull request open and no agent at work here.' : empty ?? 'Nothing waiting for a release.'}</p>
      ) : phone ? (
        <PhoneRows plan={plan} steps={steps} />
      ) : compact ? (
        <CompactRows plan={plan} onOpen={onOpen} />
      ) : (
        <Rows plan={plan} compact={compact} onOpen={onOpen} steps={steps} />
      )}
      {!merge && !strip && status?.last && <LastRelease last={status.last} now={now} />}
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

const DOT_TONE: Record<OSDot['state'], string> = { pass: 'bg-ok', fail: 'bg-danger', no_runner: 'bg-norunner', running: 'bg-accent release-step-pulse' }

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
  useKeepRepo(repo)
  const ref = repo?.unreleased?.ref
  const status = useMemo(() => {
    const board = asBoard(stats?.board)
    return releaseStatus({
      lastTag: repo?.tags?.last, unreleased: onMaster(repo?.unreleased), merged: plan.rows.filter((r) => r.stage === 'merged').length,
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

/** The key a repository's entry of the Work answer is kept under (lib/deckCache). */
export { workRepoKey }

/**
 * Keeps a repository's entry of the Work answer (its tags and changelog
 * entries, local reads) whenever a page read it, so the right panel's folded
 * Release line says the version without reading the whole Work answer.
 */
function useKeepRepo(repo: WorkRepo | undefined) {
  useEffect(() => { if (repo) writeDeck(workRepoKey(repo.root), repo) }, [repo])
}

/** How old the kept entry may be before the folded section reads the Work answer itself. */
export const REPO_KEPT_MS = 10 * 60_000

/** How long after the newest merge the section asks for the default branch's checks itself. */
export const MAIN_ASK_MS = 3_600_000

/** A failed read of the default branch's checks kept over the answer it would replace. */
const keepMainCI = (prev: SessionRepoCI, next: SessionRepoCI) => !!next.error && !!prev.ci && !next.ci

/** A Work answer standing for one kept repository entry alone: the plan's version and merges, no agents. */
function keptWork(repo: WorkRepo, now: number): Work {
  return { now, day_start: 0, sessions: [], hive: 'off', queued: [], repos: [repo], totals: { live: 0, working: 0, waiting_you: 0, today_usd: 0, machine_today_usd: 0 } }
}

/**
 * The right panel's *Release* section: the session's repository's next
 * release, as release notes (owner, 2026-11-19, translated: "the Release
 * section is unclear, it looks more like a list of PRs" — variant A, with
 * B's next step in the folded line; lib/releasenotes). It asks GitHub
 * nothing for itself: it draws the Pipeline answer the CI section, the
 * Pipeline page or the Work page last read for that repository
 * (lib/deckCache), and the Work answer, read while the section is unfolded
 * and again only on GitHub news (changesRelease) — never on every turn of
 * the agent beside it.
 *
 * Folded, its one line says where the release is, in the words and colour
 * of the stage dots (owner, 2026-11-18 and 2026-11-20; lib/releasestatus
 * releaseFold): *Nothing new since v0.182.4*, *Ready to release 0.183.1 ·
 * not started · 2 changes* (*· master checks running · 12 of 17* or
 * *· master checks failed* in place of *not started* while the default
 * branch's checks run or failed after a merge), *Waiting for #949 to merge · 0.183.1 · 2
 * changes*, *Releasing 0.183.0 · checks 1 of 3 systems*, *Release 0.183.0
 * stopped · checks failed*, *0.183.0 released · 5 min ago*. It needs the repository's tags and
 * changelog entries: the entry of the Work answer kept whenever a page read
 * it (`work:<root>`), the Work answer read folded only when none is kept or
 * the kept one is older than REPO_KEPT_MS. The release run is the copy the
 * Pipeline kept (`release:<root>`), asked here only while a release is
 * under way — a release pull request listed, a tag no release has published
 * yet, a run running — and the daemon answers it from the run it keeps.
 *
 * Unfolded, three groups split by hairlines (owner, 2026-11-19, variant A):
 * the heading (*Next release 0.183.1*, its bump and why, the last release's
 * age — or *Releasing 0.183.1*, *0.183.1 released · 5 min ago*, *Nothing
 * new since v0.183.0 · 8h ago*) over the stage dots with the status in
 * words beside them (none while nothing is new); the entries grouped by kind in their own
 * words; then the batch pull request (the release vehicle the daemon names,
 * never an ordinary feature pull request) as one *via* line and *Not in it yet*,
 * folded: pushed branches with no pull request and other open pull
 * requests. The pull request and agent rows of
 * 2026-10-18 are gone: the CI section lists the pull requests, the
 * subagent tree in Now the agents.
 */
export function CockpitRelease({ sessionId, repoRoot }: { sessionId: string; repoRoot?: string }) {
  const folded = useFolded()
  const stats = useDeckAnswer<SessionCIStats>(`stats:${repoRoot || sessionId}`)
  // The Pipeline answer the CI section reads: while its kept copy is being
  // read again, its CI words here are faint too, as of its age.
  const statsKept = useKeptCopy(`stats:${repoRoot || sessionId}`)
  const kept = useDeckAnswer<WorkRepo>(repoRoot ? workRepoKey(repoRoot) : '')
  const keptOld = !kept.d || !kept.at || Date.now() - kept.at > REPO_KEPT_MS
  const work = useWork({ on: !!repoRoot && (!folded || keptOld), changes: changesRelease })
  const liveRepo = work.data?.repos?.find((r) => r.root === repoRoot)
  useKeepRepo(liveRepo)
  const repo = liveRepo ?? kept.d
  // The pushed branches with no pull request: the deck's Branches answer
  // (local git, kept by the daemon), read unfolded, once a minute.
  const [branches] = usePoll<SessionBranches>(!folded && !!repoRoot, `release-branches:${sessionId}`, () => api.sessionBranches(sessionId), () => false, CI_IDLE_MS, `branches:${repoRoot || sessionId}`)
  const now = useNow(60_000)
  const workFor = useMemo(() => work.data ?? (kept.d ? keptWork(kept.d, now) : undefined), [work.data, kept.d, now])
  const plan = useMemo(() => (repoRoot ? planForRepo(workFor, repoRoot, stats.d, now, { branches }) : undefined), [workFor, repoRoot, stats.d, now, branches])
  const board = useMemo(() => asBoard(stats.d?.board), [stats.d?.board])
  const merged = plan ? plan.rows.filter((r) => r.stage === 'merged').length : 0
  const statusOf = (run: ReleaseCI | undefined) => releaseStatus({
    lastTag: repo?.tags?.last, unreleased: repo?.unreleased, merged,
    prs: stats.d?.prs ?? [], cards: board?.cards, releases: board?.releases ?? [], run,
  })
  // The release run: the kept copy, asked again only while a release is under way.
  const keptRun = useDeckAnswer<SessionRepoCI>(repoRoot ? `release:${repoRoot}` : '')
  const before = statusOf(keptRun.d?.release)
  // Under way: a release pull request listed, a tag no release has published
  // yet, a release published within the hour (its files may still upload),
  // or a run the kept copy says runs.
  const newest = board?.releases?.[0]
  const moving = before.phase === 'tagged' || !!before.pr || keptRun.d?.release?.state === 'running' || tagUnpublished(repo?.tags?.last?.name, board?.releases ?? [])
    || (!!newest && Date.now() - newest.published_at < OUT_RECENT_MS)
  const [run] = usePoll<SessionRepoCI>(moving && !!repoRoot, `cockpit-release:${sessionId}`, () => api.sessionCIRelease(sessionId), (d) => d.release?.state === 'running', CI_RUNNING_MS, repoRoot ? `release:${repoRoot}` : undefined,
    (prev, next) => !!next.error && !!prev.release && !next.release)
  const status = run?.release === keptRun.d?.release ? before : statusOf(run?.release)
  // The open pull request in flight that is not the release one: the batch.
  const batchPR = useMemo(() => batchOf(stats.d?.prs ?? [], repo?.unreleased?.via?.number), [stats.d?.prs, repo?.unreleased?.via?.number])
  const via = useMemo(() => (batchPR ? viaLine(batchPR, board?.cards.find((c) => c.number === batchPR.number)) : undefined), [batchPR, board])
  const batch = useMemo((): BatchPR | undefined => {
    if (!batchPR) return undefined
    const card = board?.cards.find((c) => c.number === batchPR.number)
    // Its state beside the dots: what the via line said, but never its
    // *fix: <job>*, which is CI red in plain words with the job on hover.
    return { number: batchPR.number, ci: card?.ci, next: via?.next, failed: card?.failed, state: via && via.ci.tone !== 'fail' ? via.state : undefined }
  }, [batchPR, board, via])
  // The default branch's checks while the release is ready and nothing has
  // started it (owner, 2026-11-23: *Ready to release · not started* while
  // master's CI ran after a merge): the copy the Pipeline keeps
  // (`main:<root>`), asked here only within MAIN_ASK_MS of the newest merge
  // or while the kept copy says they run; the daemon answers from its kept read.
  const ready = status.phase === 'pre' && !status.pr && !!(repo?.unreleased?.count || merged)
  const lastMerge = useMemo(() => Math.max(0, ...(stats.d?.prs ?? []).filter((p) => p.state === 'merged' && (!p.base || !board?.default_branch || p.base === board.default_branch)).map((p) => p.merged_at ?? 0)), [stats.d?.prs, board?.default_branch])
  const keptMain = useDeckAnswer<SessionRepoCI>(repoRoot ? `main:${repoRoot}` : '')
  const askMain = ready && !!repoRoot && (Date.now() - lastMerge < MAIN_ASK_MS || keptMain.d?.ci?.state === 'running')
  const [mainRead] = usePoll<SessionRepoCI>(askMain, `cockpit-main:${sessionId}`, () => api.sessionCIMain(sessionId), (d) => d.ci?.state === 'running', CI_RUNNING_MS, repoRoot ? `main:${repoRoot}` : undefined, keepMainCI)
  const mainAnswer = mainRead ?? keptMain.d
  const main = useMemo(() => (ready ? mainChecks(mainAnswer?.ci, { branch: board?.default_branch ?? mainAnswer?.branch, since: lastMerge || undefined }) : undefined), [ready, mainAnswer, board?.default_branch, lastMerge])
  if (!plan) return null
  const n = plan.rows.length
  const merge = plan.ships === 'merge'
  const fold = merge ? undefined : releaseFold(status, { waiting: repo?.unreleased?.count || merged, batch, lastTag: repo?.tags?.last?.name, now, cards: board?.cards, main })
  const keptText = statsKept.kept && statsKept.at ? asOfText(now - statsKept.at) : undefined
  const label = (
    <SectionLabel right={!folded ? (keptText ? <span data-release-kept-age title="The pull requests and their checks as last read, drawn faint while they are read again" className="shrink-0 whitespace-nowrap text-[10.5px] text-fg-faint">{keptText}</span> : undefined) : (fold ? (
      // One line in a narrow panel: the parts that do not fit wrap under it
      // and are clipped, the last first — never one cut mid-word
      // (*PR #941 gr…*). The whole line is the hover and the accessible name.
      <span data-fold-only data-release-fold={fold.kind} data-release-kept={keptText ? '' : undefined} title={`${fold.text}\n${fold.title}${keptText ? `\n${keptText}, being read again` : ''}`} aria-label={fold.text}
        className={`flex h-[16px] min-w-0 flex-wrap items-center justify-end gap-x-1 overflow-hidden leading-[16px] tabular-nums ${STATUS_TEXT[fold.tone]}${keptText ? ` ${KEPT_CLASS}` : ''}`}>
        {fold.tone === 'active' && <span aria-hidden data-release-fold-pulse className="release-step-pulse block size-[6px] shrink-0 rounded-full bg-progress" />}
        {fold.text.split(' · ').map((part, i) => (
          <span key={i} data-release-fold-part className={i === 0 ? 'min-w-0 truncate' : 'whitespace-nowrap'}>{i > 0 && <span aria-hidden className="mr-1 text-fg-faint">·</span>}{part}</span>
        ))}
      </span>
    ) : (
      <span data-fold-only className="num flex min-w-0 items-baseline gap-1.5 text-fg-muted"><span>{n} in flight</span></span>
    ))}>Release</SectionLabel>
  )
  // Where work ships on merge there is no release to write notes for: the
  // plan's own compact rows, as before.
  if (merge) {
    return (
      <section aria-label="Release" data-cockpit-release className="grid gap-2">
        {label}
        <ReleasePlan plan={plan} compact now={now} status={status} empty="No pull request open here." />
      </section>
    )
  }
  const head = notesHeading(status, repo?.tags?.last ?? plan.last, now)
  const entries = notesOf(repo, head, status)
  const others = notInIt(plan.rows, batchPR?.number)
  // What the open pull requests would make the version (owner, 2026-11-23, variant 1A).
  const hint = head.state === 'waiting' ? nextHint(status, others.prs) : undefined
  // The words beside the dots name the batch and its state while the
  // release waits for it (*Waiting for #977 · CI red*): the via line would
  // say the same again (owner, 2026-11-20), so it goes, and the words open
  // the Pipeline on it as the via line did.
  const out = head.state === 'out'
  const words = head.state !== 'idle' ? stageWords(status, stripStages(status, { out }), { cards: board?.cards, out, now, batch, main }) : undefined
  const viaInWords = !!via && words?.key === 'merged'
  const showVia = !!via && head.state !== 'shipping' && !viaInWords
  // Nothing new since the last tag: the section stays and says so. Hiding
  // it made it vanish after every release (owner, 2026-11-16).
  const empty = head.state === 'idle' && !entries.length
  return (
    <section aria-label="Release" data-cockpit-release data-release-empty={empty ? '' : undefined} data-release-notes={head.state} className="grid gap-2">
      {label}
      <div data-release-plan={plan.name} className="grid min-w-0 gap-[10px]">
        <div data-release-group="head" className="grid min-w-0 gap-1.5">
          {!repo && !work.data ? <p className="text-[12px] text-fg-muted">Reading…</p> : <NotesHead head={head} />}
          {head.state !== 'idle' && <ReleaseStrip status={status} out={out} cards={board?.cards} batch={batch} main={main} now={now}
            href={viaInWords && via ? pipelineHref(plan.root, via.number) : undefined} kept={keptText ? `${keptText}, being read again` : undefined} />}
          {hint && <NextHintLine hint={hint} />}
        </div>
        {entries.length > 0 && (
          <div data-release-group="entries" className="min-w-0 border-t border-[var(--app-hairline)] pt-2"><ReleaseNotes entries={entries} /></div>
        )}
        {(showVia || others.text) && (
          <div data-release-group="later" className="grid min-w-0 gap-1.5 border-t border-[var(--app-hairline)] pt-2">
            {showVia && via && <ViaRow via={via} root={plan.root} kept={!!keptText} />}
            {others.text && <NotInItRows others={others} root={plan.root} />}
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * The section's heading: *Next release 0.183.1 · patch · last release 8h
 * ago*, *Releasing 0.183.1 · patch*, *0.183.1 released · 5 min ago*,
 * *Nothing new since v0.183.0 · 8h ago*. It is one line at any width,
 * words going before anything is cut (owner, 2026-11-20): below 400px of
 * panel a waiting release's age goes whole (owner, 2026-11-23: a bare *27m
 * ago* read as the version's age; it stays on the version's hover), the
 * version's *release* below 340px (*Next 0.183.1 · patch · fixes only*, the
 * 330px cockpit).
 */
function NotesHead({ head: h }: { head: NotesHeading }) {
  const dot = <span aria-hidden className="shrink-0 text-fg-faint">·</span>
  const big = h.state === 'waiting' || h.state === 'shipping'
  // The short form is the full one with some words out (*Next release* →
  // *Next*, *last release 36m ago* → *36m ago*): those words alone are
  // hidden in a narrow panel, so the words read are the same at any width.
  const narrow = (full: string, short: string | undefined, wide: string) => {
    if (!short || short === full) return full
    let a = 0
    while (a < short.length && full[a] === short[a]) a++
    let b = 0
    while (b < short.length - a && full[full.length - 1 - b] === short[short.length - 1 - b]) b++
    if (a + b !== short.length) return full
    return <>{full.slice(0, a)}<span data-head-wide className={wide}>{full.slice(a, full.length - b)}</span>{full.slice(full.length - b)}</>
  }
  return (
    <header data-release-head={h.state} className="@container/head min-w-0">
      <div className="flex min-w-0 items-baseline gap-x-1.5 whitespace-nowrap text-[11.5px] text-fg-muted">
        <h3 data-release-version title={h.title} aria-label={h.text}
          className={`num cursor-help ${big ? 'shrink-0 text-[13px] font-semibold text-fg' : 'min-w-0 truncate text-[12px] text-fg-muted'}`}>{narrow(h.text, h.short, 'hidden @[340px]/head:inline')}</h3>
        {h.why && <>{dot}<span data-release-why title={h.why.title} className="shrink-0 cursor-help">{h.why.text}</span></>}
        {h.age && (h.ageWide
          // Only where it has room (owner, 2026-11-23): narrow, a bare *27m ago* read as the version's age.
          ? <span data-release-since data-release-since-wide title={h.age} className="hidden min-w-0 items-baseline gap-x-1.5 @[400px]/head:flex">{dot}<span className="num min-w-0 truncate">{h.age}</span></span>
          : <>{dot}<span data-release-since title={h.age} className={`num min-w-0 ${big ? 'truncate' : 'shrink-0'}`}>{h.age}</span></>)}
      </div>
    </header>
  )
}

/**
 * The entries under their kinds, in capitals with how many, each kind folding
 * on its heading (remembered per viewer), each entry one line behind a dot,
 * whole on hover. Owner, 2026-11-20 (translated): "a lot of text … I'd like
 * to see how many fixes there are, and bullets beside them".
 */
function ReleaseNotes({ entries }: { entries: readonly WorkEntry[] }) {
  return (
    <div data-release-entries className="grid min-w-0 gap-1.5">
      {groupNotes(entries).map((g) => <NotesKind key={g.kind} kind={g.kind} entries={g.entries} />)}
    </div>
  )
}

function NotesKind({ kind, entries }: { kind: string; entries: readonly WorkEntry[] }) {
  // usePanelFold's key present means folded, so a kind is open until folded.
  const [open, toggle] = usePanelFold(`release-notes-${kind}`)
  return (
    <div data-release-kind={kind} className="grid min-w-0 gap-0.5">
      <button type="button" aria-expanded={open} onClick={toggle} title={open ? `Fold ${kind}` : `Show ${kind}`}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left text-fg-faint hover:text-fg-muted">
        <h5 className="text-[10px] font-semibold uppercase tracking-[0.08em]">{kind}</h5>
        <span data-release-kind-count className="num rounded-full border border-[var(--app-hairline,var(--color-border))] px-1.5 text-[10px] leading-[14px]">{entries.length}</span>
        <span aria-hidden className={`text-[9px] leading-none transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
      </button>
      {open && (
        <ul className="grid min-w-0 gap-0.5">
          {entries.map((e, i) => (
            <li key={i} data-release-entry={e.source ?? ''} title={`${e.scope ? `${e.scope}: ` : ''}${e.text}${e.source === 'pr' ? '\nOn the batch pull request’s branch, not merged yet.' : ''}`}
              className="flex min-w-0 items-baseline gap-1.5 text-[12px] leading-[1.35] text-fg">
              <span aria-hidden className="shrink-0 text-fg-faint">•</span>
              <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{e.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const VIA_TONE: Record<ViaLine['ci']['tone'], string> = { ok: 'text-ok', fail: 'text-danger', pending: 'text-warn', warn: 'text-warn', muted: 'text-fg-faint' }

/** The batch pull request as one line: *via #949 ● green · ready to merge*; it opens as a row does, on the Pipeline. */
function ViaRow({ via: v, root, kept }: { via: ViaLine; root: string; kept?: boolean }) {
  return (
    <a data-release-via={v.number} href={pipelineHref(root, v.number)} title={v.title}
      className={`flex min-w-0 items-baseline gap-1.5 text-[11.5px] text-fg-muted no-underline hover:[&>[data-via-number]]:text-accent${kept ? ` ${KEPT_CLASS}` : ''}`}>
      <span className="shrink-0 text-fg-faint">via</span>
      <span data-via-number className="num shrink-0 font-medium text-fg">#{v.number}</span>
      <span data-via-ci={v.ci.tone} className={`shrink-0 whitespace-nowrap ${VIA_TONE[v.ci.tone]}`}><span aria-hidden className={v.ci.tone === 'pending' ? 'release-step-pulse mr-0.5' : 'mr-0.5'}>●</span>{v.ci.text}</span>
      <span aria-hidden className="shrink-0 text-fg-faint">·</span>
      <span data-via-state className={`min-w-0 truncate ${v.state.tone === 'danger' ? 'text-danger' : v.state.tone === 'warn' ? 'text-warn' : ''}`}>{v.state.text}</span>
    </a>
  )
}

/**
 * *Not in it yet: 1 branch, no PR ▸*: the pushed branches with no pull
 * request and the open pull requests other than the batch, folded to one
 * line until asked, remembered per viewer; unfolded, the branches as names
 * and ages (as 2026-10-19's) and the pull requests as the panel's rows.
 */
function NotInItRows({ others, root }: { others: NotInIt; root: string }) {
  const [open, setOpen] = useState<{ all?: boolean; older?: boolean }>({})
  // usePanelFold keeps the keys a viewer folded; here the key's presence means shown, so the default is folded.
  const [folded, toggle] = usePanelFold(BRANCHES_FOLD)
  const shown = shownRows('branch', others.branches, open)
  return (
    <div data-release-later="not-in-it" className="grid min-w-0 gap-0.5">
      <button type="button" data-release-section="branch" aria-expanded={!folded} onClick={toggle}
        title="On its way but not in this release: pushed branches with no pull request yet, and open pull requests other than the batch"
        className="flex min-w-0 cursor-pointer items-baseline justify-between gap-2 text-left text-[11.5px] text-fg-muted hover:text-fg">
        <span className="min-w-0 truncate"><span className="text-fg-faint">Not in it yet:</span> {others.text}</span>
        <span aria-hidden className={`shrink-0 text-[11px] leading-none transition-transform ${!folded ? 'rotate-90' : ''}`}>▸</span>
      </button>
      {!folded && (
        <>
          {others.prs.length > 0 && (
            <ul data-release-pr-lines className="@container/prs grid min-w-0 font-sans">
              {byUrgency(others.prs).map((r) => <PRLine key={r.key} row={r} root={root} />)}
            </ul>
          )}
          {others.branches.length > 0 && (
            <ul className="grid min-w-0">
              {shown.rows.map((r) => <CompactBranch key={r.key} row={r} />)}
              {(shown.more > 0 || shown.old > 0) && (
                <li className="text-[10.5px]"><MoreRows shown={shown} onAll={() => setOpen((o) => ({ ...o, all: true }))} onOlder={() => setOpen((o) => ({ ...o, older: true }))} /></li>
              )}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The line under the version when the open pull requests would change it
 * (owner, 2026-11-23, variant 1A): *0.190.0 once the 4 open PRs land*, and
 * faint under it what they are, *3 features and 1 fix waiting: #1022 …*.
 * The version above stays what the default branch holds.
 */
function NextHintLine({ hint }: { hint: NextHint }) {
  return (
    <div data-release-hint={hint.version} title={hint.title}
      className="grid min-w-0 cursor-help gap-px rounded-[6px] border border-dashed border-[var(--app-hairline,var(--color-border))] px-2 py-1 text-[11.5px] leading-[1.35]">
      <span data-release-hint-text className="min-w-0 truncate text-fg-muted"><span className="num text-fg">{hint.version}</span>{hint.text.slice(hint.version.length)}</span>
      <span data-release-hint-sub className="line-clamp-2 min-w-0 text-[11px] text-fg-faint">{hint.sub}</span>
    </div>
  )
}

const KIND_TONE: Record<string, string> = {
  feat: 'bg-[color-mix(in_srgb,var(--color-progress)_16%,transparent)] text-progress',
  fix: 'bg-[color-mix(in_srgb,var(--color-warn)_16%,transparent)] text-warn',
}
const SQUARE_TONE: Record<OSSquare['tone'], string> = {
  pass: 'bg-[color-mix(in_srgb,var(--color-ok)_18%,transparent)] text-ok',
  running: 'bg-[color-mix(in_srgb,var(--color-warn)_20%,transparent)] text-warn',
  fail: 'bg-[color-mix(in_srgb,var(--color-danger)_28%,transparent)] text-danger',
  no_runner: 'bg-[color-mix(in_srgb,var(--color-norunner)_20%,transparent)] text-norunner',
  wait: 'bg-panel-2 text-fg-faint',
}

/**
 * One open pull request that is not in the release, on one line (owner,
 * 2026-11-23, variant 2A): its number small and faint, its kind as a small
 * label in place of *feat(app):*, the rest of its title in the UI's font with
 * its first letter capitalised, cut with an ellipsis; at the right its age
 * where the panel has room, and three squares M W L, its checks on macOS,
 * Windows and Linux, each named on hover. A blocked one (a conflict,
 * changes requested) says so in a word before the squares; with no check
 * naming an OS, its state word stands in for them.
 */
function PRLine({ row: r, root }: { row: PlanRow; root: string }) {
  const k = prKind(r.title)
  const st = r.state
  const age = st.age ?? r.age
  const sq = r.squares
  // The squares say a CI failure; any other block is said in a word.
  const word = !sq || (st.rank === 0 && st.text !== 'CI failed') ? st : undefined
  const ci = sq?.map((s) => s.title).join('; ')
  const name = `${r.number ? `#${r.number} ` : ''}${r.title}`
  const title = `${name}\n${st.text}${age ? ` · opened ${age.text} ago` : ''}${sq ? `\n${sq.map((s) => s.title).join('\n')}` : ''}`
  return (
    <li data-release-row={r.number ?? r.key} data-stage={r.stage} data-release-rank={st.rank} className="flex min-w-0 items-center gap-2 py-[3px] text-[12px] leading-[18px]">
      <a href={r.number ? pipelineHref(root, r.number) : r.url} title={title} aria-label={`${name}: ${st.text}${ci ? `. ${ci}` : ''}`}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[3px] text-fg no-underline hover:[&>[data-release-title]]:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-accent">
        {r.number ? <span data-release-number className="num shrink-0 text-[10.5px] text-fg-faint">#{r.number}</span> : null}
        {k.label && <span data-release-kind={k.label} className={`shrink-0 rounded-[4px] px-[5px] text-[10px] leading-[15px] ${KIND_TONE[k.label] ?? 'bg-panel-2 text-fg-muted'}`}>{k.label}</span>}
        <span data-release-title className="min-w-0 truncate">{k.text}</span>
      </a>
      {word && <span data-release-state title={word.title} className={`shrink-0 whitespace-nowrap text-[10.5px] ${word.tone === 'danger' ? 'font-medium text-danger' : word.tone === 'warn' ? 'font-medium text-warn' : 'text-fg-faint'}`}>{word.text}</span>}
      {age && <span data-release-age title={age.title} className="num hidden shrink-0 text-[10.5px] text-fg-faint @[340px]/prs:inline">{age.text}</span>}
      {sq && (
        <span data-release-os role="img" aria-label={`CI: ${ci}`} className="flex shrink-0 items-center gap-[3px]">
          {sq.map((s) => (
            <span key={s.os} data-os={s.os} data-os-state={s.tone} title={s.title}
              className={`inline-flex size-[15px] items-center justify-center rounded-[3px] text-[9.5px] font-semibold leading-none ${SQUARE_TONE[s.tone]}`}>{s.letter}</span>
          ))}
        </span>
      )}
    </li>
  )
}
