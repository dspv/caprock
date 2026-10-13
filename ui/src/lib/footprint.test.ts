/**
 * *Copy report* prints what `caprock doctor` prints: both are pinned to one
 * fixture, testdata/footprint/doctor.{json,txt}, which cmd/caprock's
 * TestDoctorTextMatchesFixture writes and checks from the Go side.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fmtBytes, footprintText, goBytes, verdictSummary, type Footprint } from './footprint'

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

describe('the one-line verdict', () => {
  it('is All good with no warning, else how many things to look at', () => {
    const f = JSON.parse(fixture('doctor.json')) as Footprint
    expect(verdictSummary(f)).toBe('3 things to look at')
    expect(verdictSummary({ ...f, verdicts: [{ level: 'ok', code: 'ok', text: 'Nothing here looks wrong.' }] })).toBe('All good')
    expect(verdictSummary({ ...f, verdicts: [f.verdicts![0]!] })).toBe('1 thing to look at')
  })
})
