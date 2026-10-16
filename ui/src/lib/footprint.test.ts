/**
 * *Copy report* prints what `caprock doctor` prints: both are pinned to one
 * fixture, testdata/footprint/doctor.{json,txt}, which cmd/caprock's
 * TestDoctorTextMatchesFixture writes and checks from the Go side.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanupList, doctorHeadline, doctorRows, fmtBytes, footprintText, goBytes, isTestCopy, safeToStop, startedFrom, type Footprint, type Orphan } from './footprint'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const fixture = (name: string) => readFileSync(join(repo, 'testdata', 'footprint', name), 'utf8')

let tz: string | undefined
beforeAll(() => { tz = process.env.TZ; process.env.TZ = 'UTC' }) // the fixture's times are UTC, as the Go test reads them
afterAll(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz })

describe('the doctor report', () => {
  it('is the text caprock doctor prints, line for line', () => {
    const f = JSON.parse(fixture('doctor.json')) as Footprint
    expect(footprintText(f)).toBe(fixture('doctor.txt').replace(/\r\n/g, '\n'))
  })

  it('says a daemon that is not running, and leaves out what only a daemon knows', () => {
    const f = JSON.parse(fixture('doctor.json')) as Footprint
    const off: Footprint = { ...f, daemon_running: false, disk_io: undefined, actions: [] }
    const text = footprintText(off)
    expect(text).toContain('daemon          not running')
    expect(text).toContain('(CPU needs two samples; with no daemon it is not measured)')
    expect(text).not.toContain("The daemon's disk I/O")
    expect(text).not.toContain('Done on its own')
  })
})

describe('sizes', () => {
  it('prints sizes as daemon.Bytes does in the report, and down to kilobytes on screen', () => {
    expect(goBytes(2_315_255_808)).toBe('2.2 GB')
    expect(goBytes(12 * 2 ** 30)).toBe('12.0 GB')
    expect(goBytes(419_840)).toBe('410 KB')
    expect(goBytes(512)).toBe('512 B')
    expect(fmtBytes(12 * 2 ** 30)).toBe('12 GB')
    expect(fmtBytes(5000)).toBe('5 KB')
  })
})

describe('the doctor in plain words', () => {
  const f = () => JSON.parse(fixture('doctor.json')) as Footprint

  it('says one line: all good with the memory, else that Caprock uses more than it should', () => {
    expect(doctorHeadline(f())).toEqual({ ok: false, text: 'Caprock is using more than it should' })
    expect(doctorHeadline({ ...f(), verdicts: [{ level: 'ok', code: 'ok', text: 'Nothing here looks wrong.' }] })).toEqual({ ok: true, text: 'All good — Caprock uses 1.1 GB' })
    expect(doctorHeadline({ ...f(), verdicts: [{ level: 'warn', code: 'daemon_not_running', text: 'x' }] }).text).toBe('Caprock is not running')
  })

  it('groups the problems into rows a person reads, problems first', () => {
    const rows = doctorRows(f())
    expect(rows.map((r) => [r.key, r.title, r.count, r.warn])).toEqual([
      ['copies', 'Test copies of Caprock', 1, true],
      ['terminals', 'Unused Caprock terminals', 1, true],
      ['claude', 'Finished Claude sessions still running', 1, true],
      ['helpers', 'Leftover helpers', 1, true],
      ['reads', 'Disk reads', undefined, true],
    ])
    expect(rows.find((r) => r.key === 'reads')!.reason).toBe('More than usual for Caprock (over 500 MB an hour).')
    expect(rows.find((r) => r.key === 'reads')!.value).toBe('1.6 GB / hour')
    // The daemon's own sentence goes to Details, not up front.
    expect(rows[0]!.said).toContain('beside this one')
  })

  it('names agent work: worktrees, scratchpads, temporary folders', () => {
    expect(startedFrom('/Users/me/dev/caprock/.claude/worktrees/phone-end/bin/caprock')).toBe('worktree phone-end')
    expect(startedFrom(undefined, '/private/tmp/claude-501/x/scratchpad/caprock-triage/data')).toBe('agent scratchpad caprock-triage')
    expect(startedFrom('/private/var/folders/7h/xt/T/caprock-rich.0uYO/bin/caprock')).toBe('a temporary folder')
    expect(startedFrom('/opt/homebrew/bin/caprock')).toBeUndefined()
    expect(isTestCopy({ exe: '/opt/homebrew/bin/caprock', data_dir: '/Users/me/.caprock' })).toBe(false)
  })

  it('ticks only what is safe to stop', () => {
    const o = (x: Partial<Orphan>): Orphan => ({ pid: 1, started_at: 1, kind: 'claude', label: 'x', mem_bytes: 1, why: '', ...x })
    expect(safeToStop(o({ kind: 'caprock_daemon', data_dir: '/tmp/stand' }))).toBe(true)
    expect(safeToStop(o({ kind: 'caprock_daemon', data_dir: '/Users/me/.caprock-work', exe: '/opt/homebrew/bin/caprock' }))).toBe(false)
    expect(safeToStop(o({ kind: 'caprock_holder', auto: true }))).toBe(true)
    expect(safeToStop(o({ kind: 'caprock_holder' }))).toBe(false)
    expect(safeToStop(o({ kind: 'caprock_other', exe: '/Applications/Caprock Mail.app/Contents/MacOS/caprock-mail' }))).toBe(false)
    expect(safeToStop(o({ kind: 'claude_child' }))).toBe(true)
    // The fixture's holder runs claude: listed for Clean up, not ticked.
    const all = cleanupList(doctorRows(f()))
    expect(all.map((x) => x.pid)).toEqual([34399, 48120, 48133])
    expect(all.filter(safeToStop).map((x) => x.pid)).toEqual([48120, 48133])
  })
})
