import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { StorageReport } from '@/lib/api'
import { StorageView, diskRows } from './Storage'

const now = Date.UTC(2026, 9, 1, 12)

function report(over: Partial<StorageReport> = {}): StorageReport {
  return {
    data_dir: '/home/u/caprock',
    total_bytes: 900_000_000,
    files: [
      { name: 'caprock.db', bytes: 850_000_000 },
      { name: 'caprock.db-wal', bytes: 6_000_000 },
      { name: 'caprock.log', bytes: 8_000_000 },
      { name: 'service.log', bytes: 6_000_000 },
      { name: 'chats', bytes: 0, dir: true },
    ],
    database: {
      page_size: 4096,
      page_count: 207_000,
      free_pages: 0,
      tables: [
        { name: 'events', data_bytes: 600_000_000, index_bytes: 220_000_000 },
        { name: 'sessions', data_bytes: 200_000, index_bytes: 50_000 },
      ],
      events: 309_774,
      payload_bytes: 500_000_000,
      oldest_ts: Date.UTC(2025, 9, 16),
      agents: [
        { name: 'claude', events: 258_956, payload_bytes: 480_000_000 },
        { name: 'codex', events: 30_625, payload_bytes: 20_000_000 },
      ],
      kinds: [
        { name: 'tool.post', events: 86_782, payload_bytes: 350_000_000 },
        { name: 'tool.pre', events: 112_231, payload_bytes: 150_000_000 },
      ],
      recent: [{ days: 7, events: 13_000, payload_bytes: 57_000_000 }, { days: 30, events: 63_000, payload_bytes: 120_000_000 }],
      older: [{ days: 30, events: 240_000, payload_bytes: 380_000_000 }, { days: 90, events: 9_000, payload_bytes: 2_000_000 }],
    },
    measured_at: now - 5 * 60_000,
    measure_ms: 8000,
    reclaimable_bytes: 0,
    growth_bytes_per_day_est: 6_500_000,
    retention_days: 0,
    ...over,
  }
}

it('splits the database into what it holds, groups the logs, and drops empty entries', () => {
  const rows = diskRows(report())
  expect(rows.map((r) => [r.label, r.bytes])).toEqual([
    ['events', 600_000_000],
    ['event indexes', 220_000_000],
    ['other tables', 30_000_000],
    ['logs', 14_000_000],
    ['write-ahead log', 6_000_000],
  ])
})

it('names the free pages as their own row, since they are what a compaction returns', () => {
  const rows = diskRows(report({ reclaimable_bytes: 10_000_000 }))
  expect(rows.find((r) => r.label === 'free pages')?.bytes).toBe(10_000_000)
  expect(rows.find((r) => r.label === 'other tables')?.bytes).toBe(20_000_000)
})

it('shows the database whole before its composition has been measured', () => {
  const rows = diskRows(report({ database: undefined }))
  expect(rows[0]).toMatchObject({ label: 'database', bytes: 850_000_000 })
  render(<StorageView report={report({ database: undefined, growth_bytes_per_day_est: 0, measured_at: undefined })} now={now} />)
  expect(screen.getByText('measuring…')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/a day/)
})

it('states the size, labels growth as an estimate, and names the agents', () => {
  render(<StorageView report={report()} now={now} />)
  expect(screen.getByText('900.0MB')).toBeTruthy()
  expect(document.body.textContent).toMatch(/6\.5MB a day \(estimate, last 30 days\)/)
  expect(screen.getByText('Claude Code')).toBeTruthy()
  expect(screen.getByText('Codex')).toBeTruthy()
  expect(screen.getByText('tool results')).toBeTruthy()
  expect(screen.getByText('measured 5m ago')).toBeTruthy()
})

it('says what a retention setting would delete, and that the file would not shrink', () => {
  render(<StorageView report={report()} now={now} />)
  const t = document.body.textContent ?? ''
  expect(t).toMatch(/Events are kept forever/)
  expect(t).toMatch(/2\.0MB of recorded events older than 90 days, 380\.0MB older than 30/)
  expect(t).toMatch(/does not shrink/)
  expect(t).toMatch(/compacting it\s+would give back next to nothing/)
  expect(t).not.toMatch(/VACUUM/)
})

it('offers the manual compaction only when it would return something worth stopping for', () => {
  render(<StorageView report={report({ reclaimable_bytes: 200_000_000, retention_days: 90 })} now={now} />)
  const t = document.body.textContent ?? ''
  expect(t).toMatch(/Events older than 90 days are deleted/)
  expect(t).toMatch(/200\.0MB of the database is free pages/)
  expect(t).toMatch(/sqlite3 "\/home\/u\/caprock\/caprock\.db" VACUUM/)
})
