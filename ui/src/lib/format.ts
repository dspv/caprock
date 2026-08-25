// Number/time formatting shared by every screen. Costs are USD at API list
// price — on a subscription plan they are an API-price equivalent, not money
// out of pocket; the UI labels them so.

const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const usd4 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 })

// A dashboard that prints "$∞" or "NaNh NaNm" has stopped being measured, so
// every formatter falls back to an em dash rather than rendering garbage.
// Number.isFinite also rejects a non-number arriving from the wire, which
// Number.isNaN does not.
function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function fmtUSD(v: number | undefined | null): string {
  if (finite(v) === null) return '—'
  v = v as number
  if (v !== 0 && Math.abs(v) < 0.01) return usd4.format(v)
  return usd2.format(v)
}

export function fmtTokens(v: number | undefined | null): string {
  if (finite(v) === null) return '—'
  v = v as number
  const abs = Math.abs(v)
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${(v / 1_000).toFixed(1)}k`
  return new Intl.NumberFormat('en-US').format(v)
}

export function fmtPct(v: number | undefined | null, digits = 0): string {
  if (finite(v) === null) return '—'
  // Round DOWN, not to nearest: a 99.514% cache hit rate shown as "100%" reads
  // as a fabricated score in a product whose whole claim is that its numbers
  // are measured. Flooring also means a percentage never overstates what was
  // actually achieved — 89.9% is 89%, not 90%.
  const n = v as number
  if (digits === 0) {
    const floored = Math.floor(n)
    return `${Number.isFinite(floored) ? floored : 0}%`
  }
  // toFixed throws outside 0-100 digits; clamp rather than crash a render.
  const d = Math.min(100, Math.max(0, Math.trunc(finite(digits) ?? 0)))
  return `${(v as number).toFixed(d)}%`
}

export function fmtAgo(iso: string | number | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function fmtDuration(ms: number): string {
  // Was the only formatter with no guard: an empty range makes avg_session_sec
  // a 0/0 on the Go side, and the stat tile rendered a literal "NaNh NaNm".
  if (finite(ms) === null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

export function basename(p: string): string {
  const t = p.replace(/[\\/]+$/, '')
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  return i >= 0 ? t.slice(i + 1) : t
}

// fmtTool shortens a tool name for display. MCP tools arrive as
// `mcp__<server>__<tool>`; the `mcp__` prefix is noise and the full name blows
// past the column, so render it as `<server>·<tool>`. Non-MCP names pass through.
export function fmtTool(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1]}·${m[2]}` : name
}

// fmtModel drops a model's trailing snapshot date, which is the only part that
// wraps: `claude-haiku-4-5-20251001` is the same model as `claude-haiku-4-5`,
// and the eight digits push the name onto a second line where every sibling
// fits on one. Only a trailing run of 6+ digits goes — a version like `4-5` is
// what distinguishes two models and always stays.
//
// The full id is not lost, it moves to the row's tooltip: someone reconciling
// against an invoice needs the snapshot, and everyone else needs the column to
// line up.
export function fmtModel(id: string): string {
  return id.replace(/-\d{6,}$/, '…')
}
