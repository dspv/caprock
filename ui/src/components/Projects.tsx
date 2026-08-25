/**
 * Projects — per-repo spend, the first thing a user recognises as their own
 * money. Cost per project already existed in the summary but was buried in
 * History; this puts it on the landing screen, answering both halves of the
 * real question: what does this repo cost, and who is working in it right now.
 *
 * A row is a REPOSITORY, not a directory. It used to be the basename of the
 * session's cwd, which split one repo across several rows (`caprock` and `ui`)
 * and, worse, summed unrelated repos that happened to share a name. Each row
 * expands to the breakdown one level down — what `ui` cost of `caprock`'s
 * total — because "which part of the monorepo is burning the budget" is the
 * question a per-repo number raises and cannot answer on its own.
 *
 * The breakdown is charged by WHICH FILES CLAUDE TOUCHED, not by the directory
 * a session was launched from. Nobody opens a terminal in /services/api to work
 * on it — they open the repository root and let Claude edit across services —
 * so the old cwd-keyed rows answered "where was the terminal", and only one
 * repository on the owner's machine expanded at all.
 *
 * Attribution CARRIES FORWARD: a turn counts toward the directory of the most
 * recent file it touched, and keeps counting there until a touch somewhere else
 * moves it. Work happens in stretches — after "finish /app" Claude edits, runs
 * the tests, reads the output, greps, edits again — and that whole stretch is
 * work on /app.
 *
 * This replaced a STRICT rule that charged a directory only when every file a
 * turn touched was in it. That rule was exact and useless: it counted only the
 * minutes containing a direct file edit, discarded the commands in between, and
 * put 87.6% of the owner's `amarketer` into "repository-wide work" — the user
 * asked what a service cost and seven eighths of the answer was "we could not
 * tell". Under carry-forward the same repository reads /app 61%, /.ai 6.8%.
 *
 * No cost is split or pro-rated either way: a turn's price goes WHOLE to one
 * row, so the parts still sum to the repository's total. What changed is the
 * rule for deciding WHICH row — a stated rule, shown to the reader on hover
 * (TOUCH_RULE), not a guess at proportions. It is not measured file-by-file
 * attribution and must never be described as such.
 *
 * The breakdown is a TREE, one level at a time. It used to be the daemon's flat
 * list rendered as-is: 43 rows of full path on the owner's `caprock`, at depths
 * 0 to 4, ranked by cost — `/ui/src/components`, `/ui/src/screens`, `/ui/src/lib`,
 * `/ui/src`, `/internal/store`, `/internal/api`, `/.ai`, `/` — with nothing on
 * screen saying the first three live inside `/ui`. Sorted by cost it answered
 * "what is most expensive"; it could not answer "what does /ui cost", which is
 * the question a monorepo asks, and at 43 rows the eye found neither. Expanding
 * now shows `/ui`, `/internal`, `/.ai`, `/cmd`, `/docs` — each carrying its
 * subtree's total — and each expands again, to a cap of three levels
 * (pathtree.ts MAX_DEPTH). The arithmetic is in `lib/pathtree.ts`, which also
 * carries the reasoning for the cap and for building it client-side.
 *
 * Two rows are not directories: "outside the repository" (the large one — work
 * on this project whose files live elsewhere) and "repository-wide work" (now
 * small — a session's turns before it touched anything). See OUTSIDE_LABEL and
 * REPO_WIDE_LABEL. They used to render in ITALIC, which separated them from the
 * table by looking like a different product rather than by saying what they are.
 * They now read as table rows — same size, same alignment, same numerals — and
 * are separated by ROLE instead: a small-caps "not a directory" eyebrow above
 * the pair, and the path column's monospace replaced with the proportional face,
 * which is the actual difference between a path and a description.
 *
 * NOTHING IN THE BREAKDOWN NAVIGATES. A row is a figure, not a link. The rows
 * were never links in this file — but expanding a repository injected dozens of
 * rows, grew this panel far past the Live activity feed beside it, and the next
 * click landed on a feed row, every one of which IS a link to a session. The
 * owner clicked a directory and arrived at `#/session/5c987068-…` — a session in
 * a different repository entirely — and could not tell what he was looking at.
 * The fix is the tree (three rows to scan, not 43) plus rows that are inert and
 * look inert: no pointer cursor, no hover lift, nothing that promises a
 * destination. A click that lands a user somewhere they cannot orient is worse
 * than a row that does nothing.
 *
 * Two things the row shows are choices worth stating.
 *
 * BOTH figures are shown, always. There used to be a $ / tokens toggle picking
 * which one led; it is gone. On a subscription plan dollars are a proxy for
 * consumption rather than a bill, so neither number answers the question on its
 * own — and a control that makes the reader re-decide which half to see on every
 * visit costs more than the column it saves. The row has room for two numbers.
 *
 * Tokens lead, cost follows. Tokens are the honest measure of what was consumed
 * on a flat plan, and the panel header already carries the dollar total, so a
 * dollar-led row would state the same thing twice while consumption appeared
 * nowhere large. Cost is not a footnote though: it sits directly beneath at the
 * size used for a row figure elsewhere (Pulse's per-session cost, 13px) in
 * `text-fg-muted`, the tone the product uses for text meant to be read.
 * `text-fg-faint` is reserved for chrome — session counts, timestamps — and that
 * is exactly what made the old second number a whisper.
 *
 * The sparkline REPLACED a share-of-largest bar. The bar restated the ranking
 * the sorted, right-aligned numbers already gave — the widest bar sat on the
 * top row by construction — so it spent the row's only free horizontal space on
 * information the reader had. When the spend happened is not in any number
 * here: a repo that cost $40 in one afternoon and one that cost $40 across
 * three weeks are the same row until you draw them.
 *
 * Every number here is measured from captured events at API list price — never
 * modelled, never extrapolated (rule 6).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type PathShare, type ProjectShare, type SessionSummary } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtPct, fmtTokens, fmtUSD } from '@/lib/format'
import { buildSpark, bucketLabel, peak } from '@/lib/spark'
import { buildPathTree, collapseChains, MAX_DEPTH, type PathNode } from '@/lib/pathtree'
import { Panel, Skeleton } from '@/components/ui'

type Range = 'today' | '7d' | '30d' | 'all'

/** Which agent's work to show. Present only when both are on the machine. */
export type AgentFilter = 'all' | 'claude' | 'opencode'

export const AGENTS: { key: AgentFilter; label: string }[] = [
  { key: 'all', label: 'both' },
  { key: 'claude', label: 'claude' },
  { key: 'opencode', label: 'opencode' },
]

const RANGES: { key: Range; label: string }[] = [
  { key: 'today', label: 'today' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: 'all', label: 'all' },
]

/**
 * What the sparkline and the share bar are scaled on. Both series ship in the
 * payload (`spark.cost` and `spark.tokens`), so this is a display choice, not a
 * request: SPARK_BASIS names it in one place instead of leaving 'tokens' spelled
 * at four call sites where nobody could tell whether they were meant to agree.
 *
 * Tokens, to match the figure that leads the row — a picture scaled on cost
 * under a headline in tokens would be a second, silently different ranking. The
 * choice is close to free either way: the two curves have near-identical SHAPE
 * for one project, since a project's model mix barely moves within a range; they
 * diverge only ACROSS projects, which is what the shared ceiling and the bar
 * compare, and that is precisely where matching the headline matters.
 */
const SPARK_BASIS = 'tokens' as const

/**
 * What counts as touching a directory, stated where a user can see it — the
 * breakdown is otherwise a number with an invisible rule behind it.
 *
 * Kept in sync with store.TouchRule (Go), which is the definition; this is the
 * sentence shown on hover.
 */
const TOUCH_RULE =
  'A turn counts toward the directory of the most recent file it touched, and keeps counting there ' +
  'until it touches a file somewhere else — so the commands, tests and searches between two edits ' +
  'count toward the directory being worked on. Reading, editing or writing a file counts as touching ' +
  'it; running a command does not. Each turn goes whole to one row, never split between two, so the ' +
  'rows add up to the repository total exactly.'

/**
 * The two rows that are NOT directories, and the sentences that explain them.
 *
 * Both are siblings of the directory rows, not footnotes: their spend is real,
 * it is part of the repository's total, and hiding either would stop the parts
 * reconciling with the whole (rule 6).
 *
 * OUTSIDE THE REPOSITORY is the large one — 26% of `amarketer` and 29% of
 * `caprock` on the owner's database (measured 2026-08-22). It is not other
 * people's work: it is work on THIS project whose files happen to live
 * elsewhere — Claude's own notes about the project, agent scratchpads, the e2e
 * run's output directory, occasionally another checkout. A share that large has
 * to be named for what it is; folding it into repository-wide work would label
 * a quarter of the bill "no single home" when its home is known and simply not
 * in the tree, and folding it into the repository root would claim work
 * happened in the checkout that did not.
 *
 * REPOSITORY-WIDE WORK is now the small one, and it means one narrow thing: the
 * opening turns of a session, before Claude has touched any file. Under the
 * previous strict rule this row was most of the money (87.6% of `amarketer`)
 * and had to be explained away; under carry-forward it is $2.39 of $3426 there,
 * and it is usually absent entirely — the server omits it when it cost nothing.
 *
 * Neither label says "unattributed". That word describes the tool's
 * bookkeeping rather than the user's work, and reads as "caprock failed to
 * figure this out".
 */
const REPO_WIDE_LABEL = 'repository-wide work'
const REPO_WIDE_RULE =
  'Turns from the start of a session, before Claude had touched any file — so there is no ' +
  'directory yet for them to count toward. Their cost is counted here whole rather than ' +
  'guessed onto the directory the session reached later.'
const OUTSIDE_LABEL = 'outside the repository'
const OUTSIDE_RULE =
  'Turns whose most recent file touch was outside this repository — Claude’s notes on the ' +
  'project, agent scratchpads, test-output directories, or another checkout. This is real ' +
  'work and it counts toward the repository total, but it happened outside the tree, so it ' +
  'is not charged to any directory inside it.'

export function ProjectsPanel({ sessions, agent }: { sessions: SessionSummary[]; agent: AgentFilter }) {
  // 7d is the default. "today" is near-empty most mornings and would make the
  // panel look broken on first open; 30d is the opposite problem — a project
  // worked on for two days out of thirty draws a sparkline that is almost all
  // idle hairline, so the picture reads as no data rather than as a burst. A
  // week is dense enough that the shape means something and long enough to
  // carry a project that was only touched once.
  const [range, setRange] = useState<Range>('7d')
  const [expanded, setExpanded] = useState(false)
  const summary = useApi(() => api.summary(range), [range], { intervalMs: 30000 })

  const everything = summary.data?.projects ?? []
  // Whether a machine has both agents at all. The filter appears only then:
  // on a Claude-Code-only machine it would be three buttons that do nothing.
  // A repository worked on with both agents has no agent of its own, so it
  // belongs in either filter rather than in neither.
  const all = useMemo(
    () => (agent === 'all' ? everything : everything.filter((p) => !p.agent || p.agent === agent)),
    [everything, agent],
  )
  const shown = expanded ? all : all.slice(0, 6)
  const totalCost = all.reduce((sum, p) => sum + p.cost_usd, 0)
  const totalTokens = all.reduce((sum, p) => sum + p.tokens, 0)

  // The tallest column across the rows on screen, so every sparkline is drawn
  // to one ceiling and the pictures are comparable between rows.
  const ceiling = useMemo(() => peak(shown.map((p) => p.spark), SPARK_BASIS), [shown])
  // The row scale for the fallback bar, on the same basis as the sparkline it
  // stands in for — the two must not rank the rows differently.
  const maxRow = useMemo(() => shown.reduce((hi, p) => Math.max(hi, p.tokens), 0), [shown])

  return (
    <Panel
      title="Projects"
      right={
        <span className="flex items-center gap-2">
          {/* The total is stated in the same relationship as the rows: tokens
            * first, cost second and quieter. A header that summed only one of
            * the two columns below it would be answering half the panel. */}
          <span className="num text-[13px]">
            <span className="text-fg">{fmtTokens(totalTokens)}</span>
            <span className="text-fg-muted"> · {fmtUSD(totalCost)} total</span>
          </span>
          <span className="inline-flex border border-border rounded-sm overflow-hidden">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`px-1.5 py-0.5 text-[11px] mono ${
                  range === r.key ? 'bg-panel-2 text-fg' : 'text-fg-faint hover:text-fg-muted'
                }`}
              >
                {r.label}
              </button>
            ))}
          </span>
        </span>
      }
    >
      {!summary.data ? (
        <Skeleton rows={5} />
      ) : all.length === 0 ? (
        <div className="px-3 py-4 text-[12px] text-fg-muted">
          No spend captured in this range yet.
        </div>
      ) : (
        <div className="grid">
          {shown.map((p) => (
            <ProjectRow
              key={p.project || '(unknown)'}
              p={p}
              max={maxRow}
              ceiling={ceiling}
              live={liveIn(sessions).has(p.project)}
            />
          ))}
          {all.length > 6 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-fg-faint hover:text-fg-muted px-3 py-1.5 text-left border-t border-border"
            >
              {expanded ? 'show less' : `show all ${all.length} projects`}
            </button>
          )}
        </div>
      )}
    </Panel>
  )
}

/** Projects with a session that is live right now — the "who is in it" signal. */
function liveIn(sessions: SessionSummary[]): Set<string> {
  return new Set(sessions.filter((s) => s.status !== 'ended').map((s) => s.project).filter(Boolean))
}

function ProjectRow({
  p,
  max,
  ceiling,
  live,
}: {
  p: ProjectShare
  max: number
  ceiling: number
  live: boolean
}) {
  // The breakdown is absent for a repository whose work all happened in one
  // directory: a single child row would restate the parent's own total.
  const paths = p.paths ?? []
  const expandable = paths.length > 1
  const [open, setOpen] = useState(false)
  const label = p.project || 'unknown project'
  // Share-of-the-largest, on SPARK_BASIS — the bar stands in for the sparkline
  // when no series was sent, so it must rank the rows the same way and match the
  // figure that leads the row. The two orderings genuinely differ: a cheap model
  // burns tokens cheaply, so the costliest repository is not always the busiest.
  const pct = max > 0 ? (100 * p.tokens) / max : 0
  const bars = useMemo(() => buildSpark(p.spark, SPARK_BASIS, ceiling), [p.spark, ceiling])
  // The flat list, folded into the tree the panel shows. Buckets come back
  // separately: they are not paths and have no place in a path hierarchy.
  const tree = useMemo(() => {
    const t = buildPathTree(paths)
    return { roots: collapseChains(t.roots), buckets: t.buckets }
  }, [paths])
  // The bar's scale is the largest thing on the FIRST level, by tokens — the
  // rows a reader compares are the siblings in front of them, and a deeper row
  // is scaled against its own siblings for the same reason. Scaling every level
  // against the repository would leave every nested bar a stub.
  const maxTop = useMemo(
    () => Math.max(0, ...tree.roots.map((n) => n.tokens), ...tree.buckets.map((b) => b.tokens)),
    [tree],
  )

  const body = (
    <div className="grid grid-cols-[1fr_128px_auto] items-center gap-3 w-full text-left">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {live && <span className="inline-block w-1.5 h-1.5 rounded-full bg-ok shrink-0" title="a session is live in this project" />}
          <span className="truncate text-[14px]">{label}</span>
          {/* Only the second agent is marked. On most machines every row is
            * Claude Code, so labelling those too would put a badge on every
            * line — the mark answers "why is this one different". */}
          {p.agent === 'opencode' && (
            <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-fg-faint border border-border px-1 rounded-sm">
              oc
            </span>
          )}
          <span className="text-[11px] text-fg-faint num shrink-0">
            {p.sessions} {p.sessions === 1 ? 'session' : 'sessions'}
          </span>
          {expandable && (
            // The caret is the only affordance, so it carries the state: a
            // chevron that turns, in the faint tone used for chrome elsewhere.
            <span
              aria-hidden
              className={`text-[9px] text-fg-faint shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            >
              ▶
            </span>
          )}
        </div>
      </div>
      {/* The sparkline sits between the name and the number, in its own fixed
        * column, so the numbers stay on one right-aligned edge and the pictures
        * on another. Ragged columns are what make a dense table unreadable. */}
      {bars.length > 0 ? (
        <SparkCanvas bars={bars} widthMs={p.spark?.width_ms ?? 0} label={label} />
      ) : (
        // `range=all` sends no series (its buckets would have no stated width),
        // so the row keeps the share bar rather than showing an empty gap.
        <div className="h-1 bg-panel-2 rounded-sm overflow-hidden" title={`${label}: share of the largest project`}>
          <div className="h-full bg-accent/70" style={{ width: `${pct}%` }} />
        </div>
      )}
      {/* Both figures, stacked and sharing the row's one right edge. Side by side
        * they would need a second aligned column and read as two ranked lists;
        * stacked, they read as one quantity described twice. The cost line is a
        * readable 13px `text-fg-muted` — the size Pulse gives a per-session cost
        * — not the 11px `text-fg-faint` this panel uses for chrome. */}
      <div className="text-right shrink-0">
        <div className="num text-[17px] font-semibold leading-tight text-accent">{fmtTokens(p.tokens)}</div>
        <div className="num text-[13px] leading-tight text-fg-muted">{fmtUSD(p.cost_usd)}</div>
      </div>
    </div>
  )

  return (
    <div className="border-t border-border first:border-t-0">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="w-full px-3 py-1.5 hover:bg-panel-2/50"
          title={`${label}: show cost by directory`}
        >
          {body}
        </button>
      ) : (
        <div className="px-3 py-1.5">{body}</div>
      )}
      {expandable && open && (
        <div className="pb-1.5 bg-panel-2/30">
          {/* The basis of the percentage, said in words. The column's base is
            * the repository total INCLUDING the rows nothing could be
            * attributed to, so it sums to 100% — and a reader who is not told
            * the denominator is being asked to guess it (rule 6). */}
          <div
            className="pl-7 pr-3 pt-1 pb-0.5 text-[10px] text-fg-faint"
            title={TOUCH_RULE}
          >
            by files touched · share of this repository's tokens
          </div>
          {/* The largest is computed, not taken as roots[0]: the tree is sorted
            * by cost, so the first row is not necessarily the one with the most
            * tokens, and using it as the scale would push another row past
            * 100%. */}
          {tree.roots.map((n) => (
            <DirRow key={n.path} n={n} max={maxTop} />
          ))}
          {/* The rows that are not directories, under their own heading. They
            * are siblings of the tree, not children of it: their spend is real
            * and part of the repository total, but it belongs to no path. */}
          {tree.buckets.length > 0 && (
            <>
              <div className="pl-7 pr-3 pt-2 pb-0.5 text-[10px] uppercase tracking-[0.08em] text-fg-faint">
                not a directory
              </div>
              {tree.buckets.map((q) => (
                <BucketRow key={q.path} q={q} max={maxTop} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One directory of the breakdown tree — charged by what the repository's TURNS
 * touched, not by where a session was launched. Indented and quieter than its
 * parent so the eye keeps the repository as the unit and reads these as its
 * parts.
 *
 * WHAT THE ROW STATES is the SUBTREE total: `/ui` reads $387.25, everything at
 * or below it. That is what "what does /ui cost" means, and it is the reason the
 * tree exists — the flat list could not answer it at any price.
 *
 * THE PARENT'S OWN SPEND is a separate fact and gets its own words. Work that
 * touched a file directly in `/ui`, rather than in `/ui/src`, is $0.39 of that
 * $387.25 — and a reader who cannot separate the two cannot tell "this directory
 * cost X" from "this subtree cost X". So an expandable row whose own spend is
 * non-zero carries a sub-line: "$0.39 here · $386.86 in 1 subdirectory". It is
 * shown only when it is non-zero and only when the row has children, because on
 * a leaf the two figures are the same number and stating it twice is noise.
 *
 * SPEND DEEPER THAN THE CAP is rolled into the deepest visible row and the row
 * SAYS SO — "+1 deeper" beside the path, with the count of directories folded
 * in on hover. It cannot be dropped (the parts would stop summing to the whole)
 * and it cannot have a row (that is what the cap means), so the only honest
 * option left is to absorb it visibly. `/ui/src/screens` carries
 * `/ui/src/screens/orchestration` this way on the owner's data.
 *
 * NOTHING HERE IS A LINK. See the file header: the breakdown row is a figure.
 * The only interactive thing is the expander, and it looks like the one on the
 * repository row above it because it is the same control doing the same job.
 *
 * There is no sparkline here on purpose: a series per directory would multiply
 * the payload of a polled endpoint for a picture that is hidden until the row
 * is expanded, and the question a breakdown answers is "how much", not "when".
 *
 * THE PERCENTAGE. Its base is the REPOSITORY's total, including the rows that
 * are not directories, so the column sums to 100% and the share that belongs to
 * no one directory is visible as its own number rather than hidden in the
 * denominator. The header says so in words, because a percentage whose base the
 * reader has to guess is exactly the kind of number rule 6 exists to prevent.
 * It is recomputed here rather than read from `tokens_pct`, because the server
 * sends a share per FLAT path and this row is a subtree — the denominator is the
 * same, but the numerator is the roll-up.
 *
 * It is a share of TOKENS, and it sits with the token figure — not between the
 * two numbers, where it would read as applying to both. Cost per token varies
 * by model, so the two shares genuinely differ; the cost share is available on
 * hover rather than as a fifth column, because two competing percentages side
 * by side is the ambiguity this was meant to remove.
 *
 * Percentages FLOOR (fmtPct): 99.6% is 99%, never 100%. Nothing reads as the
 * whole until it is the whole. A row with real spend but a tiny share would
 * floor to "0%", which next to a real dollar figure says two contradictory
 * things — so anything under 0.1% is rendered "<0.1%" instead.
 */
function DirRow({ n, max }: { n: PathNode; max: number }) {
  const [open, setOpen] = useState(false)
  const bar = max > 0 ? (100 * n.tokens) / max : 0
  const expandable = n.children.length > 0
  // The child rows are compared with each other, so they are scaled against
  // each other — a nested bar scaled on the repository would be a stub at every
  // depth below the first.
  const maxChild = useMemo(
    () => Math.max(0, ...n.children.map((c) => c.tokens)),
    [n.children],
  )
  // Own spend is worth stating only when it is real AND when there is something
  // to distinguish it from. On a leaf, own and subtree are the same number.
  const showOwn = expandable && n.ownCost > 0
  const kids = n.children.length

  const body = (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 w-full text-left">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12px] text-fg-muted mono">{n.path}</span>
          {n.rolledUp > 0 && (
            // The cap, said out loud. A row that silently absorbed its children
            // would be a number with an invisible rule behind it (rule 6).
            <span
              className="text-[10px] text-fg-faint shrink-0"
              title={`${n.rolledUp} ${n.rolledUp === 1 ? 'directory' : 'directories'} below this one ${n.rolledUp === 1 ? 'is' : 'are'} counted here rather than shown: the breakdown stops at ${MAX_DEPTH} levels.`}
            >
              +{n.rolledUp} deeper
            </span>
          )}
          <span className="text-[10px] text-fg-faint num shrink-0">
            {n.turns} {n.turns === 1 ? 'turn' : 'turns'}
          </span>
          {expandable && (
            // The same chevron the repository row uses, at the same size and in
            // the same tone — one expander pattern in the panel, not two.
            <span
              aria-hidden
              className={`text-[9px] text-fg-faint shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            >
              ▶
            </span>
          )}
        </div>
        {showOwn && (
          <div className="text-[10px] text-fg-faint mt-0.5">
            {fmtUSD(n.ownCost)} here · {fmtUSD(n.cost - n.ownCost)} in {kids}{' '}
            {kids === 1 ? 'subdirectory' : 'subdirectories'}
          </div>
        )}
        <div className="h-0.5 mt-1 bg-panel-2 rounded-sm overflow-hidden">
          <div className="h-full bg-accent/40" style={{ width: `${bar}%` }} />
        </div>
      </div>
      <div
        className="text-right shrink-0 num text-[12px]"
        title={`${fmtPctFloor(n.costPct)} of this repository's cost`}
      >
        <span className="text-fg-muted">{fmtTokens(n.tokens)}</span>
        {/* The share sits with the tokens it describes, in the faint chrome
          * tone, so it reads as a qualifier rather than a third quantity. */}
        <span className="text-fg-faint"> {fmtPctFloor(n.tokensPct)}</span>
        <span className="text-fg-faint"> · {fmtUSD(n.cost)}</span>
      </div>
    </div>
  )

  // Indent by depth so the hierarchy is legible without a guide line. The base
  // is the repository row's own indent; each level adds the width of one
  // segment's worth of eye travel.
  const indent = { paddingLeft: `${28 + (n.depth - 1) * 14}px` }

  return (
    <div>
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="w-full pr-3 py-1 hover:bg-panel-2/50"
          style={indent}
          title={`${n.path}: show the directories inside it`}
        >
          {body}
        </button>
      ) : (
        <div className="pr-3 py-1" style={indent}>
          {body}
        </div>
      )}
      {expandable && open &&
        n.children.map((c) => (
          <DirRow key={c.path} n={c} max={maxChild} />
        ))}
    </div>
  )
}

/**
 * One of the two rows that are NOT directories — "outside the repository" and
 * "repository-wide work".
 *
 * THE RESTYLE. They used to render in ITALIC with a left rule, which separated
 * them from the table by making them look like a different product: a slanted
 * face in a panel that has none anywhere else reads as an error state or as
 * pasted-in text, not as a row of the same table. They are siblings of the
 * directory rows — their spend is real, it is part of the repository total, and
 * hiding or othering either would stop the parts reconciling with the whole.
 *
 * They are now separated by ROLE, not by looking foreign:
 *
 *   - A small-caps "not a directory" eyebrow sits above the pair, in the same
 *     10px faint tracking the panel uses for its other section labels. The
 *     grouping says what they are once, rather than each row having to say it
 *     again by being visually strange.
 *   - The path column drops its MONOSPACE. That is the real difference between
 *     a path and a description of some work, and it is the difference the eye
 *     already reads without being told — `mono` in this panel means "this is a
 *     literal string from the machine".
 *   - Everything else matches: the same 12px, the same alignment, the same
 *     right-edge numerals, the same bar geometry. The bar keeps the faint fill,
 *     because it is a share of a different KIND of thing and a full-strength
 *     accent would put it in the ranking the directories are competing in.
 *
 * Neither label says "unattributed" — that word describes the tool's
 * bookkeeping rather than the user's work.
 */
function BucketRow({ q, max }: { q: PathShare; max: number }) {
  const pct = max > 0 ? (100 * q.tokens) / max : 0
  const un = q.unattributed === true
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-3 pl-7 pr-3 py-1">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="truncate text-[12px] text-fg-muted"
            title={un ? REPO_WIDE_RULE : OUTSIDE_RULE}
          >
            {un ? REPO_WIDE_LABEL : OUTSIDE_LABEL}
          </span>
          <span className="text-[10px] text-fg-faint num shrink-0">
            {q.turns} {q.turns === 1 ? 'turn' : 'turns'}
          </span>
        </div>
        <div className="h-0.5 mt-1 bg-panel-2 rounded-sm overflow-hidden">
          <div className="h-full bg-fg-faint/30" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div
        className="text-right shrink-0 num text-[12px]"
        title={`${fmtPctFloor(q.cost_pct)} of this repository's cost`}
      >
        <span className="text-fg-muted">{fmtTokens(q.tokens)}</span>
        <span className="text-fg-faint"> {fmtPctFloor(q.tokens_pct)}</span>
        <span className="text-fg-faint"> · {fmtUSD(q.cost_usd)}</span>
      </div>
    </div>
  )
}

/**
 * A share of the repository total, floored — never rounded up — and never shown
 * as a bare "0%" for a row that really did spend.
 *
 * fmtPct already floors (a 99.6% share must not read as the whole). The extra
 * rule here is the small end: flooring a real 0.04% share to "0%" would put a
 * zero next to a non-zero dollar figure on the same line, which is a
 * contradiction rather than a rounding. "<0.1%" is the honest floor: it says
 * the share is smaller than the panel can express without claiming it is
 * nothing.
 */
function fmtPctFloor(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0%'
  if (v < 0.1) return '<0.1%'
  return fmtPct(v)
}

/**
 * The sparkline canvas. Painted the way Pulse.tsx paints its track — on data
 * change rather than on a timer, with an empty bucket drawn as a hairline so a
 * quiet day reads as silence instead of as a hole in the chart.
 *
 * Unlike Pulse, the colours are read from the design tokens rather than
 * hardcoded rgba, because this canvas sits in a panel that is also rendered in
 * the light theme, where Pulse's fixed dark-theme colours would be wrong.
 */
function SparkCanvas({
  bars,
  widthMs,
  label,
}: {
  bars: ReturnType<typeof buildSpark>
  widthMs: number
  label: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const paint = () => {
      const w = cv.clientWidth
      const h = cv.clientHeight
      if (w === 0 || h === 0) return
      const dpr = window.devicePixelRatio || 1
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      const ctx = cv.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // Tokens from the stylesheet, so the sparkline follows the theme. A
      // canvas cannot use a CSS variable directly, so it is resolved once per
      // paint against the element itself.
      const css = getComputedStyle(cv)
      const accent = css.getPropertyValue('--color-accent').trim() || '#feb157'
      const faint = css.getPropertyValue('--color-fg-faint').trim() || '#837f78'

      const bw = w / bars.length
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i]
        if (!b) continue
        const x = i * bw
        // A one-pixel gutter keeps 30 columns from fusing into a solid block,
        // but never at the cost of the column itself disappearing.
        const width = Math.max(1, bw - 1)
        if (b.empty) {
          // Silence, drawn rather than left blank — the same hairline the live
          // pulse uses, so an empty bucket is visibly distinct from a low one.
          ctx.fillStyle = faint
          ctx.globalAlpha = 0.28
          ctx.fillRect(x, h - 1, width, 1)
          ctx.globalAlpha = 1
          continue
        }
        // A non-empty bucket is never shorter than 2px: at this height a
        // faithful sub-pixel column would be indistinguishable from silence,
        // and "a little" must not render as "nothing".
        const bh = Math.max(2, b.height * h)
        ctx.fillStyle = accent
        // Muted against the headline number, which is the same accent at full
        // strength — the picture supports the figure, it does not compete.
        ctx.globalAlpha = 0.65
        ctx.fillRect(x, h - bh, width, bh)
        ctx.globalAlpha = 1
      }
    }
    paint()
    // Repaint on resize only — the data itself arrives through the effect deps.
    const ro = new ResizeObserver(paint)
    ro.observe(cv)
    return () => ro.disconnect()
  }, [bars])

  // The whole picture gets one title rather than a hover readout per column:
  // at 14px tall a column is not a hit target, and the row is already a button
  // that expands the breakdown — stealing its clicks would break that.
  const spent = bars.filter((b) => !b.empty)
  const first = spent[0]
  const last = spent[spent.length - 1]
  const span =
    !first || !last
      ? 'no spend in this range'
      : first === last
        ? `all of it on ${bucketLabel(first.at, widthMs)}`
        : `${bucketLabel(first.at, widthMs)} → ${bucketLabel(last.at, widthMs)}`

  return (
    <canvas
      ref={ref}
      className="w-full h-[14px] block"
      role="img"
      aria-label={`${label}: ${SPARK_BASIS} over time, ${span}`}
      title={`${label}: when the spend happened — ${span}`}
    />
  )
}
