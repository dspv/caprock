/**
 * What GitHub Actions runner minutes cost, as the session deck says it
 * (owner, 2026-10-12, translated: "can we add runner costs?"). The daemon
 * prices each finished job from the versioned runner rate table
 * (`pricing/actions.json`, read from GitHub's documentation; .ai/03-contracts.md
 * § Runner cost): this file only words it. Every figure is an estimate at
 * list rate, labelled so; a job the table cannot price is "unpriced" with the
 * reason, never a guess (rule 6). What GitHub actually billed is the separate
 * usage line, read from its billing report.
 */

/** Why a job has no price (RunnerCost.reason). */
export type UnpricedReason = 'self_hosted' | 'unknown_runner' | 'unfinished' | 'no_table'

/** One job's cost (`github.RunnerCost`). */
export interface RunnerCost {
  priced: boolean
  reason?: UnpricedReason
  sku?: string
  display?: string
  match?: 'label' | 'name'
  larger?: boolean
  rate_usd_per_min?: number
  minutes_billed: number
  usd: number
  free_public: boolean
}

/** A run's or a commit's sum over its finished jobs (`github.CICost`). */
export interface CICost {
  usd: number
  minutes_billed: number
  free_minutes: number
  unpriced_minutes: number
  priced_jobs: number
  unpriced_jobs: number
  unfinished_jobs: number
  partial: boolean
  visibility: 'public' | 'private' | 'unknown'
  table_version?: string
  table_source?: string
}

/** GET /v1/github/actions-usage: what GitHub billed for Actions this month. */
export interface ActionsUsage {
  account: string
  org: boolean
  year: number
  month: number
  available: boolean
  reason?: 'not_connected' | 'permission' | 'not_found' | 'error'
  needs?: string[]
  minutes: number
  gross_usd: number
  discount_usd: number
  net_usd: number
  by_sku: { sku: string; unit_type: string; quantity: number; gross_usd: number; discount_usd: number; net_usd: number }[]
  endpoint?: string
  at: number
  error?: { message: string }
}

/** GitHub's page saying public repositories run free on standard runners. */
export const PUBLIC_FREE_DOC = 'https://docs.github.com/en/billing/concepts/product-billing/github-actions'
/** Where a fine-grained token's permissions are changed. */
export const TOKEN_SETTINGS_URL = 'https://github.com/settings/personal-access-tokens'

export type CostTone = 'cost' | 'free' | 'muted'
export interface CostLabel { text: string; tone: CostTone; title: string }

/** Dollars as the deck shows them: "$0.31", "<$0.01", "$12.40". */
export function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

const ESTIMATE = 'An estimate at GitHub’s list rate, before any minutes a private repository’s plan includes'
const FREE = `GitHub does not charge for standard GitHub-hosted runners in a public repository (${PUBLIC_FREE_DOC}, read 2026-10-12)`

/** "Rate table 2026-10-12.1 · https://docs.github.com/…": where the rates come from. */
export function tableLine(c?: Pick<CICost, 'table_version' | 'table_source'>): string {
  if (!c?.table_version) return ''
  return `Rate table ${c.table_version}${c.table_source ? ` · ${c.table_source}` : ''}`
}

function lines(...xs: (string | false | undefined)[]): string {
  return xs.filter(Boolean).join('\n')
}

function unpricedWhy(reason: UnpricedReason | undefined, labels?: string[]): string {
  switch (reason) {
    case 'self_hosted': return 'A self-hosted runner: its minutes are not GitHub-hosted minutes, so Caprock does not price them'
    case 'unknown_runner': return `Its runner${labels?.length ? ` (${labels.join(', ')})` : ''} is not in the rate table, so it is left unpriced rather than guessed`
    case 'no_table': return 'The runner rate table did not load'
    default: return 'Not priced'
  }
}

/**
 * One job's cost beside its time: "$0.31", "$0" (free in a public repository),
 * "unpriced" (self-hosted or a runner the table does not know, the reason in
 * the tooltip); nothing while it runs.
 */
export function jobCostLabel(c: RunnerCost | undefined, table?: CICost, labels?: string[]): CostLabel | undefined {
  if (!c || c.reason === 'unfinished') return undefined
  const src = tableLine(table)
  if (!c.priced) return { text: 'unpriced', tone: 'muted', title: lines(unpricedWhy(c.reason, labels), src) }
  const runner = c.display || c.sku || 'runner'
  const mins = `${c.minutes_billed} min billed (rounded up per job)`
  if (c.free_public) return { text: '$0', tone: 'free', title: lines(`${runner}: ${mins}, free — ${FREE}`, src) }
  const rate = c.rate_usd_per_min !== undefined ? ` × $${c.rate_usd_per_min}/min` : ''
  return { text: fmtCost(c.usd), tone: 'cost', title: lines(`${runner}: ${mins}${rate} = ${fmtCost(c.usd)}`, ESTIMATE, src) }
}

/**
 * A run's or a pull request's cost: "$0.42", "$0 · public repo" when every
 * priced minute was free, "≥$0.42" when a job is still running or could not
 * be priced (the sum is short of the whole), "unpriced" when nothing could
 * be; nothing before any job finished.
 */
export function sumCostLabel(c: CICost | undefined): CostLabel | undefined {
  if (!c) return undefined
  if (c.priced_jobs === 0 && c.unpriced_jobs === 0) return undefined
  const src = tableLine(c)
  const short = [
    c.unfinished_jobs > 0 && `${c.unfinished_jobs} job${c.unfinished_jobs === 1 ? '' : 's'} still running`,
    c.unpriced_jobs > 0 && `${c.unpriced_jobs} job${c.unpriced_jobs === 1 ? '' : 's'} unpriced (${c.unpriced_minutes} min: self-hosted or a runner the table does not know)`,
  ].filter(Boolean).join('; ')
  const partial = short ? `Partial: ${short}` : ''
  if (c.priced_jobs === 0) return { text: 'unpriced', tone: 'muted', title: lines(partial, src) }
  const vis = c.visibility === 'unknown' ? 'The repository’s visibility is unknown, so it is priced as private' : ''
  if (c.usd <= 0 && c.free_minutes > 0) {
    return { text: '$0 · public repo', tone: 'free', title: lines(`${c.free_minutes} min on standard runners, free: ${FREE}`, partial, src) }
  }
  const free = c.free_minutes > 0 ? `${c.free_minutes} min free (public repository, standard runners)` : ''
  return {
    text: `${c.partial ? '≥' : ''}${fmtCost(c.usd)}`,
    tone: 'cost',
    title: lines(`${c.minutes_billed} min billed, ${fmtCost(c.usd)}`, free, partial, ESTIMATE, vis, src),
  }
}

/** Sums the runs of one commit, as `CI.cost` does, for a PR row from the runs it read. */
export function sumRuns(costs: (CICost | undefined)[]): CICost | undefined {
  let out: CICost | undefined
  for (const c of costs) {
    if (!c) continue
    if (!out) { out = { ...c }; continue }
    out.usd = Math.round((out.usd + c.usd) * 1e6) / 1e6
    out.minutes_billed += c.minutes_billed
    out.free_minutes += c.free_minutes
    out.unpriced_minutes += c.unpriced_minutes
    out.priced_jobs += c.priced_jobs
    out.unpriced_jobs += c.unpriced_jobs
    out.unfinished_jobs += c.unfinished_jobs
    out.partial = out.partial || c.partial
  }
  return out
}

/** The usage line's states: GitHub's own figure, a permission to grant, or a quiet reason. */
export type UsageLine =
  | { kind: 'available'; text: string; title: string }
  | { kind: 'permission'; text: string; title: string; url: string }
  | { kind: 'quiet'; text: string; title: string }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * What GitHub itself billed for Actions this month (its billing usage report,
 * read only when the Main view is shown): "Actions this month: 1,240 min ·
 * $7.40" (net of GitHub's discount, which is how included minutes appear);
 * "Real billing: needs the token's Plan (read) permission" with a link when
 * the token may not read it; undefined while GitHub is not connected.
 */
export function usageLine(u: ActionsUsage | undefined): UsageLine | undefined {
  if (!u || u.reason === 'not_connected') return undefined
  const who = `${u.org ? 'organization' : 'account'} ${u.account}`
  if (u.available) {
    const period = `${MONTHS[u.month - 1] ?? u.month} ${u.year}`
    const skus = u.by_sku.slice(0, 6).map((s) => `${s.sku}: ${Math.round(s.quantity).toLocaleString('en-US')} ${s.unit_type.toLowerCase()} · $${s.net_usd.toFixed(2)}`)
    return {
      kind: 'available',
      text: `Actions this month: ${Math.round(u.minutes).toLocaleString('en-US')} min · $${u.net_usd.toFixed(2)}`,
      title: lines(`What GitHub billed the ${who} for Actions in ${period}, from its billing usage report`,
        `Gross $${u.gross_usd.toFixed(2)} − discount $${u.discount_usd.toFixed(2)} (included minutes) = $${u.net_usd.toFixed(2)}`, ...skus),
    }
  }
  if (u.reason === 'permission') {
    const what = u.org ? 'Administration (read) permission, as an organization admin' : 'Plan (read) permission'
    return {
      kind: 'permission',
      text: `Real billing: needs the token’s ${what}`,
      title: lines(`GitHub refused to show the ${who}’s billing usage to this token.`, u.needs?.length ? `It needs: ${u.needs.join('; ')}` : '', 'Open the token settings'),
      url: TOKEN_SETTINGS_URL,
    }
  }
  if (u.reason === 'not_found') return { kind: 'quiet', text: 'Real billing: not available for this account', title: `GitHub has no billing usage report for the ${who}: it is only on GitHub’s enhanced billing platform` }
  return { kind: 'quiet', text: 'Real billing not read', title: u.error?.message ?? 'GitHub’s billing report could not be read' }
}
