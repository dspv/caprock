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
 * **No Compact button.** VACUUM rewrites the whole file: it needs room for a
 * second copy, holds the write lock for the whole run (ingest stalls behind
 * it), and gives back only the free pages — which on a database that never
 * deletes is nothing. The panel shows how much a compaction would return, and
 * only when that is worth something does it say how to run one by hand.
 */
import { api, type StorageReport, type StorageSlice } from '@/lib/api'
import { useApi } from '@/lib/useApi'
import { fmtAgo, fmtBytes } from '@/lib/format'
import { Panel } from '@/components/ui'
import { Bars } from '@/components/Breakdown'
import { agentName } from '@/components/Projects'

export function StoragePanel() {
  // The composition is re-measured every half hour; polling faster only
  // re-reads the file sizes, which is all that can move in between.
  const r = useApi(() => api.storage(), [], { live: false, intervalMs: 60000 })
  if (!r.data) return null
  return <StorageView report={r.data} now={Date.now()} />
}

/** Below this, a compaction is not worth stopping Caprock for. */
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

/** The database's path, spelled the way this machine spells paths. */
function dbPath(dir: string): string {
  return dir + (dir.includes('\\') && !dir.includes('/') ? '\\' : '/') + 'caprock.db'
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
    <Panel
      title="Storage"
      right={db && s.measured_at ? <span title={`measured in ${((s.measure_ms ?? 0) / 1000).toFixed(1)}s`}>measured {fmtAgo(s.measured_at, now)}</span> : 'measuring…'}
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-3 pt-3 text-[11px] text-fg-muted">
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

      <div className="grid gap-x-8 gap-y-5 px-3 py-3 md:grid-cols-2">
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

      <div className="grid gap-1.5 border-t border-border px-3 py-2.5 text-[11px] text-fg-muted">
        {s.retention_days > 0 ? (
          <p>
            <span className="text-fg">Events older than {s.retention_days} days are deleted</span>, every six hours.
            The file does not shrink: new events reuse the space the old ones leave.
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
            . The file does not shrink: new events reuse the space the old ones leave, so it stops growing instead.
          </p>
        )}
        {db && (
          s.reclaimable_bytes >= worthCompacting ? (
            <p>
              <span className="num text-fg">{fmtBytes(s.reclaimable_bytes)}</span> of the database is free pages. Caprock does not
              compact while it runs — that locks the database and needs room for a second copy. To get it back, stop it with{' '}
              <span className="mono text-fg">caprock down</span>, run{' '}
              <span className="mono text-fg break-all">sqlite3 "{dbPath(s.data_dir)}" VACUUM</span>, and start it again.
            </p>
          ) : (
            <p>
              Free space inside the database: <span className="num text-fg">{fmtBytes(s.reclaimable_bytes)}</span> — compacting it
              would give back next to nothing.
            </p>
          )
        )}
        {s.error && <p className="text-warn">Last measurement failed: {s.error}</p>}
      </div>
    </Panel>
  )
}
