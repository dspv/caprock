/**
 * A mini pipeline, as GitLab draws one beside a merge request (owner,
 * 2026-10-12, translated: "I'd like the CI/CD stages together with the pull
 * requests — like GitLab's pipeline indicators"): a small circle per job,
 * joined by a thin line within a workflow, set apart between workflows. ✓ on
 * green passed, ✗ on red failed, a turning ring running, hollow queued, a
 * grey slash skipped or cancelled — the shape says it as well as the colour.
 * Hover names the job, its state and its time; a click hands the job to the
 * caller (the CI cell opens it), or opens its link when it is no Actions job.
 */
import type { CITone, PipeNode } from '@/lib/ci'
import { nodeTitle } from '@/lib/ci'

/** The most circles drawn; the rest are counted. */
export const PIPE_MAX = 14

function Mark({ tone }: { tone: CITone }) {
  if (tone === 'running') return <span aria-hidden className="ci-spin inline-block h-[10px] w-[10px] shrink-0 rounded-full" />
  if (tone === 'pass' || tone === 'fail') {
    return (
      <svg aria-hidden viewBox="0 0 10 10" className={`h-[10px] w-[10px] shrink-0 ${tone === 'pass' ? 'text-ok' : 'text-danger'}`}>
        <circle cx="5" cy="5" r="5" fill="currentColor" />
        <path d={tone === 'pass' ? 'M2.8 5.2 4.3 6.6 7.2 3.6' : 'M3.3 3.3 6.7 6.7M6.7 3.3 3.3 6.7'} fill="none" stroke="var(--app-chrome-bg, #fff)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return <span aria-hidden className="pipe-node" data-tone={tone} />
}

/** How wide the compact circles of these nodes are drawn, in px. */
export function compactWidth(nodes: PipeNode[]): number {
  const shown = Math.min(nodes.length, PIPE_MAX)
  let groups = 0
  for (let i = 1; i < shown; i++) if (nodes[i]!.group !== nodes[i - 1]!.group) groups++
  return shown * 10 + groups * 4 + (nodes.length > PIPE_MAX ? 22 : 0)
}

export function MiniPipeline({ nodes, label, onPick, compact }: { nodes: PipeNode[]; label: string; onPick?: (n: PipeNode) => void; compact?: boolean }) {
  if (nodes.length === 0) return null
  if (compact) return <CompactPipeline nodes={nodes} label={label} onPick={onPick} />
  const shown = nodes.length > PIPE_MAX ? nodes.slice(0, PIPE_MAX - 1) : nodes
  const more = nodes.length - shown.length
  return (
    <span role="list" aria-label={label} data-pipeline className="inline-flex shrink-0 items-center">
      {shown.map((n, i) => {
        const prev = shown[i - 1]
        return (
          <span key={n.key} role="listitem" className="inline-flex items-center">
            {prev && (prev.group === n.group ? <span aria-hidden className="pipe-link" /> : <span aria-hidden className="inline-block w-[6px]" />)}
            <button type="button" data-pipe-node={n.jobId ?? n.key} data-tone={n.tone} aria-label={nodeTitle(n)} title={nodeTitle(n)}
              disabled={!onPick && !n.url}
              onClick={(e) => { e.stopPropagation(); onPick?.(n) }}
              className="flex h-[14px] w-[12px] items-center justify-center rounded-full outline-offset-1 hover:brightness-110 disabled:cursor-default">
              <Mark tone={n.tone} />
            </button>
          </span>
        )
      })}
      {more > 0 && <span className="num ml-1 text-[10px] text-fg-faint" title={nodes.slice(shown.length).map(nodeTitle).join('\n')}>+{more}</span>}
    </span>
  )
}

/**
 * The circles small and plain, as the deck's rows and the cockpit draw them:
 * a filled circle per check coloured by its state, a running one pulsing, a
 * queued one hollow; no joining line, a gap between workflows.
 */
function CompactPipeline({ nodes, label, onPick }: { nodes: PipeNode[]; label: string; onPick?: (n: PipeNode) => void }) {
  const shown = nodes.length > PIPE_MAX ? nodes.slice(0, PIPE_MAX - 1) : nodes
  const more = nodes.length - shown.length
  return (
    <span role="list" aria-label={label} data-pipeline="compact" className="inline-flex shrink-0 items-center">
      {shown.map((n, i) => {
        const prev = shown[i - 1]
        return (
          <span key={n.key} role="listitem" className={`inline-flex items-center ${prev && prev.group !== n.group ? 'ml-[4px]' : ''}`}>
            <button type="button" data-pipe-node={n.jobId ?? n.key} data-tone={n.tone} aria-label={nodeTitle(n)} title={nodeTitle(n)}
              disabled={!onPick && !n.url}
              onClick={(e) => { e.stopPropagation(); onPick?.(n) }}
              className="flex h-[12px] w-[10px] items-center justify-center rounded-full outline-offset-1 hover:brightness-110 disabled:cursor-default">
              <span aria-hidden className="pipe-node" data-size="sm" data-tone={n.tone} />
            </button>
          </span>
        )
      })}
      {more > 0 && <span className="num ml-1 text-[10px] text-fg-faint" title={nodes.slice(shown.length).map(nodeTitle).join('\n')}>+{more}</span>}
    </span>
  )
}
