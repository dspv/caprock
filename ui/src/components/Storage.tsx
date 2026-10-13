/**
 * What Caprock keeps on disk, what it is made of, how fast it grows, and what
 * the user can do about it.
 *
 * Asked for as "our SQLite probably bloats like crazy — how much does all this
 * take?". It lives on the Status screen beside the settings rather than on a
 * screen of its own: it is a figure checked once in a while, next to the one
 * setting that changes it.
 *
 * **Every figure is counted, except one, which says so.** Sizes come from the
 * filesystem and from SQLite's own page map. The growth rate is the last 30
 * days of recorded events scaled by what a recorded byte has cost on disk so
 * far — an estimate, and labelled as one.
 *
 * **No Compact button.** Caprock compacts on its own while idle: it replaces
 * the base64 images older rows still hold, runs one VACUUM when the disk has
 * room for a second copy, and from then on gives free pages back to the disk
 * as they appear (internal/daemon/compact.go). The panel says which of those
 * is true; there is nothing for the user to run.
 */
import { api, type StorageReport, type StorageSlice } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtAgo, fmtBytes } from '@/lib/format'
import { Details, Section } from '@/components/SettingsParts'
import { Bars } from '@/components/Breakdown'
import { agentName } from '@/components/Projects'

export function StoragePanel() {
  // The composition is measured when this panel finds it a day old (and once
  // a day while the daemon is idle); polling faster only re-reads the file
  // sizes, which is all that can move in between.
  const r = useApi(() => api.storage(), [], { live: false, intervalMs: 60000 })
  if (!r.data) return null
  return <StorageView report={r.data} now={Date.now()} />
}

/** Below this, free space inside the database is not worth a sentence. */
const worthCompacting = 64_000_000

const KIND_LABEL: Record<string, string> = {
  'tool.post': 'tool results',
  'tool.pre': 'tool calls',
  'turn.assistant': 'replies',
  'turn.user': 'your prompts',
  'agent.stop': 'turn ends',
}

const FILE_LABEL: Record<string, string> = {
  'caprock.db-wal': 'write-ahead log',
  'caprock.db-shm': 'WAL index',
  'caprock-hook': 'hook shim',
  chats: 'chats',
  paste: 'pasted files',
}

type Row = { key: string; label: string; bytes: number }

/** The data directory as one list: the database split into what it holds,
 *  then every other file. Logs are one row, because nobody cares which. */
export function diskRows(s: StorageReport): Row[] {
  const rows: Row[] = []
  let logs = 0
  let dbFile = 0
  for (const f of s.files ?? []) {
    if (f.name === 'caprock.db') dbFile = f.bytes
    else if (f.name.endsWith('.log')) logs += f.bytes
    else rows.push({ key: f.name, label: FILE_LABEL[f.name] ?? f.name + (f.dir ? '/' : ''), bytes: f.bytes })
  }
  if (logs > 0) rows.push({ key: 'logs', label: 'logs', bytes: logs })
  const ev = s.database?.tables?.find((t) => t.name === 'events')
  if (ev && dbFile > 0) {
    // The rest of the file is every other table plus the free pages, and the
    // free pages get their own row: they are the part a compaction returns.
    const free = s.reclaimable_bytes
    const rest = Math.max(0, dbFile - ev.data_bytes - ev.index_bytes - free)
    rows.push({ key: 'ev', label: 'events', bytes: ev.data_bytes })
    rows.push({ key: 'evi', label: 'event indexes', bytes: ev.index_bytes })
    rows.push({ key: 'rest', label: 'other tables', bytes: rest })
    if (free > 0) rows.push({ key: 'free', label: 'free pages', bytes: free })
  } else if (dbFile > 0) {
    rows.push({ key: 'db', label: 'database', bytes: dbFile })
  }
  return rows.filter((r) => r.bytes > 0).sort((a, b) => b.bytes - a.bytes)
}

function bars(rows: Row[], total: number, top: number) {
  const head = rows.slice(0, top)
  const tail = rows.slice(top).reduce((n, r) => n + r.bytes, 0)
  if (tail > 0) head.push({ key: 'other', label: 'everything else', bytes: tail })
  const max = head.reduce((m, r) => Math.max(m, r.bytes), 0)
  return head.map((r) => ({
    key: r.key,
    label: r.label,
    value: fmtBytes(r.bytes),
    share: total > 0 ? (100 * r.bytes) / total : null,
    frac: max > 0 ? r.bytes / max : 0,
  }))
}

function sliceRows(xs: StorageSlice[], label: (n: string) => string): Row[] {
  return xs.map((x) => ({ key: x.name, label: label(x.name), bytes: x.payload_bytes }))
}

export function StorageView({ report: s, now }: { report: StorageReport; now: number }) {
  const db = s.database
  const disk = diskRows(s)
  const older = db?.older.find((w) => w.days === 90)
  const older30 = db?.older.find((w) => w.days === 30)
  return (
    <Section
      title="Storage"
      aside={
        <span className="text-[11px] text-fg-faint">
          {db && s.measured_at ? <span title={`measured in ${((s.measure_ms ?? 0) / 1000).toFixed(1)}s`}>measured {fmtAgo(s.measured_at, now)}</span> : 'measuring…'}
          {db && s.measured_at && s.measuring ? ' · measuring…' : null}
        </span>
      }
    >
      {/* The headline is all most people want: how big, how fast it grows.
        * What it is made of and what to do about it are one click down. */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[12px] text-fg-muted">
        <span>
          <span className="num text-[18px] text-fg">{fmtBytes(s.total_bytes)}</span> on disk
        </span>
        {s.growth_bytes_per_day_est > 0 && (
          <span title="Events recorded over the last 30 days, scaled by what each recorded byte has cost on disk so far. An estimate.">
            ≈ <span className="num text-fg">{fmtBytes(s.growth_bytes_per_day_est)}</span> a day (estimate, last 30 days)
          </span>
        )}
        {db && db.events > 0 && (
          <span>
            <span className="num text-fg">{db.events.toLocaleString('en-US')}</span> events since{' '}
            <span className="num text-fg">{new Date(db.oldest_ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          </span>
        )}
      </div>

      <Details summary="Details">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-5 md:grid-cols-2">
        <Bars title="On disk" cols={{ value: 'size', share: 'share' }} rows={bars(disk, s.total_bytes, 6)} />
        {db && db.payload_bytes > 0 && (
          <div className="grid gap-4">
            {/* Shares of what the events recorded, not of the file: indexes
              * and page overhead are not anyone's in particular. */}
            <Bars
              title="Recorded, by agent"
              cols={{ value: 'recorded', share: 'share' }}
              rows={bars(sliceRows(db.agents, agentName), db.payload_bytes, 4)}
            />
            <Bars
              title="Recorded, by kind"
              cols={{ value: 'recorded', share: 'share' }}
              rows={bars(sliceRows(db.kinds, (k) => KIND_LABEL[k] ?? k), db.payload_bytes, 4)}
            />
          </div>
        )}
      </div>

      <div className="grid gap-1.5 border-t border-border pt-2.5 text-[12px] text-fg-muted">
        {s.retention_days > 0 ? (
          <p>
            <span className="text-fg">Events older than {s.retention_days} days are deleted</span>, every six hours.
            {s.returns_free_space
              ? ' The space they leave goes back to the disk while Caprock is idle.'
              : ' New events reuse the space they leave until Caprock has compacted the database once.'}
          </p>
        ) : (
          <p>
            <span className="text-fg">Events are kept forever.</span> Set <span className="mono text-fg">retention_days</span> in{' '}
            <span className="mono">config.json</span> and restart Caprock to delete older ones
            {older && older30 && older30.events > 0 ? (
              <>
                {' '}— today that is <span className="num text-fg">{fmtBytes(older.payload_bytes)}</span> of recorded events older than 90 days,{' '}
                <span className="num text-fg">{fmtBytes(older30.payload_bytes)}</span> older than 30
              </>
            ) : null}
            .{s.returns_free_space
              ? ' The space deleted events leave goes back to the disk while Caprock is idle.'
              : ' New events reuse the space deleted ones leave until Caprock has compacted the database once.'}
          </p>
        )}
        {db && (
          s.reclaimable_bytes >= worthCompacting ? (
            <p>
              <span className="num text-fg">{fmtBytes(s.reclaimable_bytes)}</span> of the database is free space.{' '}
              {s.returns_free_space
                ? 'Caprock gives it back to the disk the next time it is idle.'
                : 'Caprock compacts the database once, on its own, the next time it is idle and the disk has room for a second copy; after that free space goes back to the disk as it appears.'}
            </p>
          ) : (
            <p>
              Free space inside the database: <span className="num text-fg">{fmtBytes(s.reclaimable_bytes)}</span> —
              {s.returns_free_space ? ' given back to the disk while Caprock is idle.' : ' compacting it would give back next to nothing.'}
            </p>
          )
        )}
      </div>
      </Details>
      {s.error && <p className="text-[12px] text-warn">Last measurement failed: {s.error}</p>}
    </Section>
  )
}
