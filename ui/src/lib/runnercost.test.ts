import { describe, expect, it } from 'vitest'
import { fmtCost, jobCostLabel, sumCostLabel, sumRuns, tableLine, usageLine, type ActionsUsage, type CICost, type RunnerCost } from './runnercost'

const table = { table_version: '2026-10-12.1', table_source: 'https://docs.github.com/en/billing/reference/actions-runner-pricing' }
const sum = (p: Partial<CICost> = {}): CICost => ({ usd: 0, minutes_billed: 0, free_minutes: 0, unpriced_minutes: 0, priced_jobs: 0, unpriced_jobs: 0, unfinished_jobs: 0, partial: false, visibility: 'private', ...table, ...p })
const job = (p: Partial<RunnerCost> = {}): RunnerCost => ({ priced: true, sku: 'actions_macos', display: 'macOS 3-core (M1)', rate_usd_per_min: 0.062, minutes_billed: 5, usd: 0.31, free_public: false, ...p })

describe('runner cost labels', () => {
  it('formats dollars without inventing precision', () => {
    expect(fmtCost(0.31)).toBe('$0.31')
    expect(fmtCost(12.4)).toBe('$12.40')
    expect(fmtCost(0.004)).toBe('<$0.01')
    expect(fmtCost(0)).toBe('$0')
  })

  it('prices a finished job, with the rate, the table version and its source in the tooltip', () => {
    const l = jobCostLabel(job(), sum())!
    expect(l.text).toBe('$0.31')
    expect(l.tone).toBe('cost')
    expect(l.title).toMatch(/macOS 3-core \(M1\): 5 min billed \(rounded up per job\) × \$0\.062\/min = \$0\.31/)
    expect(l.title).toMatch(/estimate at GitHub’s list rate/)
    expect(l.title).toContain('Rate table 2026-10-12.1 · https://docs.github.com/en/billing/reference/actions-runner-pricing')
  })

  it('says $0 for a standard runner in a public repository, and why', () => {
    const l = jobCostLabel(job({ free_public: true, usd: 0, sku: 'actions_linux', display: 'Linux 2-core (x64)' }), sum({ visibility: 'public' }))!
    expect(l.text).toBe('$0')
    expect(l.tone).toBe('free')
    expect(l.title).toMatch(/does not charge for standard GitHub-hosted runners in a public repository/)
  })

  it('leaves a self-hosted or unknown runner unpriced with the reason, and says nothing while a job runs', () => {
    const self = jobCostLabel(job({ priced: false, reason: 'self_hosted', usd: 0 }), sum())!
    expect(self.text).toBe('unpriced')
    expect(self.tone).toBe('muted')
    expect(self.title).toMatch(/self-hosted runner/)
    const unknown = jobCostLabel(job({ priced: false, reason: 'unknown_runner', usd: 0 }), sum(), ['gpu-box'])!
    expect(unknown.title).toMatch(/\(gpu-box\) is not in the rate table/)
    expect(jobCostLabel(job({ priced: false, reason: 'unfinished' }))).toBeUndefined()
    expect(jobCostLabel(undefined)).toBeUndefined()
  })

  it('sums a run or a PR: priced, free in a public repository, partial, unpriced, or nothing yet', () => {
    expect(sumCostLabel(sum({ usd: 0.42, minutes_billed: 9, priced_jobs: 3 }))).toMatchObject({ text: '$0.42', tone: 'cost' })
    const free = sumCostLabel(sum({ free_minutes: 12, priced_jobs: 4, visibility: 'public' }))!
    expect(free.text).toBe('$0 · public repo')
    expect(free.tone).toBe('free')
    expect(free.title).toMatch(/12 min on standard runners, free/)
    const partial = sumCostLabel(sum({ usd: 0.42, minutes_billed: 9, priced_jobs: 2, unpriced_jobs: 1, unpriced_minutes: 4, partial: true }))!
    expect(partial.text).toBe('≥$0.42')
    expect(partial.title).toMatch(/Partial: 1 job unpriced \(4 min/)
    expect(partial.title).toContain(tableLine(table))
    const running = sumCostLabel(sum({ usd: 0.1, minutes_billed: 2, priced_jobs: 1, unfinished_jobs: 2, partial: true }))!
    expect(running.title).toMatch(/2 jobs still running/)
    expect(sumCostLabel(sum({ unpriced_jobs: 2, unpriced_minutes: 7, partial: true }))).toMatchObject({ text: 'unpriced', tone: 'muted' })
    expect(sumCostLabel(sum({ unfinished_jobs: 3, partial: true }))).toBeUndefined()
    expect(sumCostLabel(undefined)).toBeUndefined()
    expect(sumCostLabel(sum({ usd: 1, minutes_billed: 10, priced_jobs: 1, visibility: 'unknown' }))!.title).toMatch(/visibility is unknown/)
  })

  it('sums the runs of a commit', () => {
    const s = sumRuns([sum({ usd: 0.1, minutes_billed: 2, priced_jobs: 1 }), undefined, sum({ usd: 0.2, minutes_billed: 3, priced_jobs: 2, partial: true, unfinished_jobs: 1 })])!
    expect(s.usd).toBeCloseTo(0.3)
    expect(s.minutes_billed).toBe(5)
    expect(s.priced_jobs).toBe(3)
    expect(s.partial).toBe(true)
    expect(sumRuns([])).toBeUndefined()
  })
})

describe('the usage line', () => {
  const usage = (p: Partial<ActionsUsage>): ActionsUsage => ({ account: 'ada', org: false, year: 2026, month: 10, available: false, minutes: 0, gross_usd: 0, discount_usd: 0, net_usd: 0, by_sku: [], at: 0, ...p })

  it('says what GitHub billed this month, net of the included minutes', () => {
    const l = usageLine(usage({ available: true, minutes: 1240.4, gross_usd: 12.4, discount_usd: 5, net_usd: 7.4, by_sku: [{ sku: 'actions_linux', unit_type: 'Minutes', quantity: 1240, gross_usd: 12.4, discount_usd: 5, net_usd: 7.4 }] }))!
    expect(l.kind).toBe('available')
    expect(l.text).toBe('Actions this month: 1,240 min · $7.40')
    expect(l.title).toMatch(/October 2026/)
    expect(l.title).toMatch(/Gross \$12\.40 − discount \$5\.00/)
  })

  it('names the permission a token lacks, with a link to the token settings', () => {
    const l = usageLine(usage({ reason: 'permission', needs: ['"Plan" user permission (read), for a fine-grained token'] }))!
    expect(l.kind).toBe('permission')
    expect(l.text).toBe('Real billing: needs the token’s Plan (read) permission')
    expect(l.kind === 'permission' && l.url).toBe('https://github.com/settings/personal-access-tokens')
    expect(l.title).toMatch(/"Plan" user permission/)
    expect(usageLine(usage({ reason: 'permission', org: true, account: 'acme' }))!.text).toMatch(/Administration \(read\)/)
  })

  it('is quiet when the report does not exist or failed, and absent while GitHub is not connected', () => {
    expect(usageLine(usage({ reason: 'not_found' }))).toMatchObject({ kind: 'quiet', text: 'Real billing: not available for this account' })
    expect(usageLine(usage({ reason: 'error', error: { message: 'boom' } }))).toMatchObject({ kind: 'quiet', title: 'boom' })
    expect(usageLine(usage({ reason: 'not_connected' }))).toBeUndefined()
    expect(usageLine(undefined)).toBeUndefined()
  })
})
