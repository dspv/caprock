// Number/time formatting shared by every screen. Costs are USD at API list
// price — on a subscription plan they are an API-price equivalent, not money
// out of pocket; the UI labels them so.

const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const usd4 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 })

export function fmtUSD(v: number | undefined | null): string {
  if (v === undefined || v === null || Number.isNaN(v)) return '—'
  if (v !== 0 && Math.abs(v) < 0.01) return usd4.format(v)
  return usd2.format(v)
}

export function fmtTokens(v: number | undefined | null): string {
  if (v === undefined || v === null) return '—'
  const abs = Math.abs(v)
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${(v / 1_000).toFixed(1)}k`
  return new Intl.NumberFormat('en-US').format(v)
}

export function fmtPct(v: number | undefined | null, digits = 0): string {
  if (v === undefined || v === null || Number.isNaN(v)) return '—'
  return `${v.toFixed(digits)}%`
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
  if (ms < 1000) return `${ms}ms`
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
