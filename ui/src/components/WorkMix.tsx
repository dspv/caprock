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
      'Turns that ran a shell command — builds, tests, git, anything through Bash. ' +
      'The command itself is free; what costs is the turn that issued it and read its output.',
  },
  read: {
    label: 'reading and searching',
    title:
      'Turns that read or searched the codebase — Read, Grep, Glob. ' +
      'The file contents enter the prompt and are billed, which is why reading is not free.',
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
      'Turns that called no tool at all. They may have been reasoning, planning, answering a ' +
      'question or writing prose — Caprock records which tools ran, not what a turn was thinking, ' +
      'so it does not claim to know which.',
  },
}

/**
 * The rule, stated where the reader can see it. A breakdown with an invisible
 * rule behind it is a number nobody can check.
 *
 * Kept in sync with store.WorkKindRule (Go), which is the definition.
 */
const WORK_RULE =
  'Each turn counts toward one kind of work, decided by the tools it called: writing a file wins ' +
  'over running a command, which wins over reading or searching, then web, then an MCP tool, then ' +
  'anything else. A turn that called no tool is counted as exactly that. Each turn goes whole to ' +
  'one row, never split, so the rows add up to the total exactly.'

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
          {unlinked.toLocaleString()} tool calls in this range could not be matched to the turn that
          paid for them, so their cost is counted under “no tool call” rather than the work they
          actually did. Every other row is understated by up to that much.
        </div>
      )}
    </Panel>
  )
}
