import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MiniPipeline, PIPE_MAX } from './MiniPipeline'
import { checkNodes, jobNodes, nodeTitle, type PipeNode } from '@/lib/ci'
import type { CIRun } from '@/lib/api'

const now = 1_800_000_000_000

describe('the mini pipeline', () => {
  it('draws a circle per job in each state, joined within a workflow and apart between them', () => {
    const runs: CIRun[] = [
      { id: 1, name: 'CI', status: 'in_progress', jobs: [
        { id: 13, run_id: 1, name: 'test (windows)', status: 'in_progress', started_at: now - 65_000, labels: [], steps: [] },
        { id: 11, run_id: 1, name: 'lint', status: 'completed', conclusion: 'success', started_at: now - 300_000, completed_at: now - 240_000, duration_ms: 60_000, labels: [], steps: [] },
        { id: 14, run_id: 1, name: 'smoke', status: 'queued', labels: [], steps: [] },
        { id: 12, run_id: 1, name: 'test (macos)', status: 'completed', conclusion: 'failure', started_at: now - 200_000, completed_at: now - 13_000, duration_ms: 187_000, labels: [], steps: [] },
      ] },
      { id: 2, name: 'Docs', status: 'completed', conclusion: 'cancelled', jobs: [
        { id: 21, run_id: 2, name: 'pages', status: 'completed', conclusion: 'cancelled', labels: [], steps: [] },
      ] },
    ]
    const nodes = jobNodes(runs, now)
    // In the order they started, the ones not started last.
    expect(nodes.map((n) => n.name)).toEqual(['lint', 'test (macos)', 'test (windows)', 'smoke', 'pages'])
    expect(nodes.map((n) => n.tone)).toEqual(['pass', 'fail', 'running', 'queued', 'skipped'])
    render(<MiniPipeline nodes={nodes} label="CI" />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(5)
    expect(screen.getByRole('button', { name: 'test (macos) · failed · 3m 07s' })).toHaveAttribute('data-tone', 'fail')
    expect(screen.getByRole('button', { name: 'test (windows) · running · 1m 05s' })).toHaveAttribute('data-tone', 'running')
    expect(screen.getByRole('button', { name: 'smoke · queued' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pages · skipped or cancelled' })).toHaveAttribute('data-tone', 'skipped')
    // A line within CI; a gap before Docs.
    expect(items[1]!.querySelector('.pipe-link')).not.toBeNull()
    expect(items[4]!.querySelector('.pipe-link')).toBeNull()
  })

  it('reads a PR’s checks: running from a check run’s status, its job from its link', () => {
    const nodes = checkNodes([
      { name: 'build', state: 'pending', status: 'in_progress', started_at: now - 30_000, job_id: 71, url: 'https://github.com/a/b/actions/runs/7/job/71' },
      { name: 'deploy', state: 'pending', status: 'queued' },
      { name: 'codecov', state: 'pass', url: 'https://codecov.example/x' },
    ], now)
    expect(nodes.map((n) => [n.name, n.tone, n.jobId])).toEqual([['build', 'running', 71], ['deploy', 'queued', undefined], ['codecov', 'pass', undefined]])
    expect(nodeTitle(nodes[0]!)).toBe('build · running · 30s')
  })

  it('hands a clicked circle to the caller, and counts what does not fit', () => {
    const onPick = vi.fn()
    const nodes: PipeNode[] = Array.from({ length: PIPE_MAX + 3 }, (_, i) => ({ key: String(i), name: `j${i}`, tone: 'pass', jobId: i + 1 }))
    render(<MiniPipeline nodes={nodes} label="many" onPick={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: 'j2 · passed' }))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ jobId: 3 }))
    expect(screen.getAllByRole('listitem')).toHaveLength(PIPE_MAX - 1)
    expect(screen.getByText('+4')).toBeInTheDocument()
  })
})
