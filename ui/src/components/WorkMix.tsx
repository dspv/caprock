/**
 * WorkMix — what the money was spent ON, beside "Model mix" and "Per project"
 * on the Cost screen.
 *
 * WHY IT EXISTS. The Cost screen already answers how much (totals), on which
 * model, and where (project, and one level down, directory). It could not
 * answer what the money went ON: a $200 day looks identical whether it was
 * spent running the test suite, editing files, or reading the codebase. That
 * question has no answer anywhere else in the product, and it is the one a
 * person asks first when the number surprises them.
 *
 * THE RULE. Each turn counts toward one kind of work, decided by the tools it
 * called, with a stated precedence (WORK_RULE). A turn's cost goes WHOLE to one
 * row and is never split — the same promise the per-directory breakdown makes —
 * so the rows add up to the range total exactly.
 *
 * THE LABELS ARE THE DESIGN. Each one has to survive the question "is that true
 * of every turn in this row?", because a flattering label is an invented number
 * in words (rule 6). The one that matters most is the last: a turn that called
 * no tool is called exactly that. It is NOT "conversation", "thinking" or
 * "planning" — such a turn may have been reasoning, answering a question,
 * planning, or writing prose, and picking one of those would assert something
 * the data does not say. "No tool call" is mechanical, unflattering and true.
 *
 * WHY THE PANEL MATCHES ITS NEIGHBOURS EXACTLY. It is the third cut of one
 * question, not a new kind of thing, so it is the same table in the same panel
 * at the same density: name, turns, tokens, cost, share. A different shape here
 * would suggest a different kind of fact.
 */
import { type Summary, type WorkKind } from '@/lib/api'
import { fmtPct, fmtTokens, fmtUSD } from '@/lib/format'
import { Empty, Panel, Skeleton } from '@/components/ui'

/**
 * What each row is called, and the sentence explaining it on hover.
 *
 * Kept in sync with store.WorkKindRule and the WorkKind constants (Go), which
 * are the definition; these are the words shown to a person.
 */
const LABELS: Record<WorkKind, { label: string; title: string }> = {
  edit: {
    label: 'writing code',
    title: 'Turns that wrote to a file — Edit, Write, NotebookEdit.',
  },
  command: {
    label: 'running commands',
    title:
      'Turns that ran a shell command — builds, tests, git, anything through Bash.',
  },
  read: {
    label: 'reading and searching',
    title:
      'Turns that read or searched the codebase — Read, Grep, Glob.',
  },
  web: {
    label: 'web research',
    title: 'Turns that fetched or searched the web — WebFetch, WebSearch.',
  },
  mcp: {
    label: 'MCP tools',
    title: 'Turns that called one of your own MCP integrations.',
  },
  other: {
    label: 'other tools',
    title:
      'Turns that called a tool in none of the categories above — subagents, task and skill ' +
      'control, and any tool Caprock does not yet know by name.',
  },
  none: {
    label: 'no tool call',
    title:
      'Turns that called no tool — reasoning, planning, or writing prose.',
  },
}

/**
 * The rule, stated where the reader can see it. A breakdown with an invisible
 * rule behind it is a number nobody can check.
 *
 * Kept in sync with store.WorkKindRule (Go), which is the definition.
 */
const WORK_RULE =
  'Each turn counts once, under its most expensive kind of tool. Rows add up to the total.'

export function WorkMix({ summary }: { summary?: Summary }) {
  const s = summary
  const rows = s?.work ?? []
  // The "no tool" row is only as trustworthy as the linkage behind it: a tool
  // call that could not be attached to its turn leaves that turn looking as
  // though it called nothing. The count is published rather than hidden, so a
  // degraded database says so instead of quietly producing a finding (rule 6).
  const unlinked = s?.work_unlinked_calls ?? 0
  const toolCalls = s?.tool_calls ?? 0
  // A handful of unlinked calls out of tens of thousands cannot move a row
  // enough to matter, and a permanent warning nobody can act on is noise. The
  // threshold is 1% of the range's tool calls.
  const degraded = unlinked > 0 && toolCalls > 0 && unlinked / toolCalls > 0.01
  return (
    <Panel title="What it went on" right={<span title={WORK_RULE}>by cost</span>}>
      {!s ? <Skeleton rows={4} /> : rows.length === 0 && <Empty title="No priced turns in range" />}
      <table className="w-full text-[12px]">
        <tbody>
          {rows.map((w) => (
            <tr key={w.kind} className="border-b border-border/60 last:border-0">
              <td className="px-3 py-1" title={LABELS[w.kind]?.title}>
                {LABELS[w.kind]?.label ?? w.kind}
              </td>
              <td className="px-3 py-1 num text-right text-fg-muted">{w.turns} turns</td>
              <td className="px-3 py-1 num text-right text-fg-muted">{fmtTokens(w.tokens)}</td>
              <td className="px-3 py-1 num text-right">{fmtUSD(w.cost_usd)}</td>
              <td className="px-3 py-1 num text-right text-fg-faint w-14">{fmtPct(w.cost_pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {degraded && (
        <div className="mx-3 mb-2.5 text-[11px] text-warn">
          {unlinked.toLocaleString()} tool calls could not be matched to a turn, so their cost lands
          under “no tool call”. The other rows are understated.
        </div>
      )}
    </Panel>
  )
}

/**
 * The same breakdown, compact enough to ride under the projects list on Now.
 *
 * "Which repository" and "what kind of work" are halves of one question, and
 * asking the second one meant leaving the screen you live on. This shows the
 * top few kinds as one bar plus a legend rather than a table — the shape of
 * the answer, with the table on Cost for the figures.
 *
 * It renders nothing when the linkage is too degraded to mean anything: on a
 * `today` range most tool calls have not been attached to their turn yet, so
 * nearly all cost lands in "no tool call" and the bar would say something
 * false. A panel that appears only when it can be trusted beats a permanent
 * one carrying a caveat.
 */
export function WorkMixStrip({ summary }: { summary?: Summary }) {
  const rows = summary?.work ?? []
  const unlinked = summary?.work_unlinked_calls ?? 0
  const toolCalls = summary?.tool_calls ?? 0
  if (rows.length === 0 || toolCalls === 0) return null
  // A fifth of the calls unattached is the point where the picture stops being
  // about the work and starts being about the gap.
  if (unlinked / toolCalls > 0.2) return null

  const top = rows.filter((w) => w.cost_pct >= 1).slice(0, 5)
  if (top.length === 0) return null

  return (
    <div className="border-t border-border px-3 py-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.12em] text-fg-faint">
          what it went on
        </span>
        <a href="#/cost" className="text-[10px] text-fg-faint hover:text-accent no-underline">
          details →
        </a>
      </div>
      <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-panel-2" title={WORK_RULE}>
        {top.map((w, i) => (
          <span
            key={w.kind}
            className="h-full"
            style={{
              width: `${w.cost_pct}%`,
              background: 'var(--color-accent)',
              opacity: 1 - i * 0.17,
            }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {top.map((w, i) => (
          <span key={w.kind} className="inline-flex items-baseline gap-1.5 text-[11px]">
            <span
              className="inline-block h-2 w-2 rounded-[2px] translate-y-[1px]"
              style={{ background: 'var(--color-accent)', opacity: 1 - i * 0.17 }}
            />
            <span className="text-fg-muted" title={LABELS[w.kind]?.title}>
              {LABELS[w.kind]?.label ?? w.kind}
            </span>
            <span className="num text-fg-faint">{fmtPct(w.cost_pct)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
