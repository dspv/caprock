import { describe, expect, it } from 'vitest'
import { caprockTotal, emptyHistory, fromReport, merge, pointsOf, stats, topConsumers, type ResourceHistory } from './resourceHistory'
import type { ResourceReport, SessionResources } from './resources'

const MB = 2 ** 20

function sess(id: string, cpu: number, mem: number, warm = true): SessionResources {
  return { session_id: id, pid: 1, cpu_pct: cpu, mem_bytes: mem, procs: 1, warm, top: [], hot: false }
}

function report(at: number, sessions: SessionResources[]): ResourceReport {
  return {
    at, sessions,
    caprock: {
      daemon: { pid: 1, name: 'caprock', cpu_pct: 1, mem_bytes: 100 * MB },
      app: { pid: 2, name: 'caprock-app', cpu_pct: 0.5, mem_bytes: 10 * MB },
      webview: { count: 2, cpu_pct: 2, mem_bytes: 300 * MB, procs: [] },
      hosts: { count: 1, mem_bytes: 20 * MB, cpu_pct: 0.25, orphans: 0, reapable: 0, list: [] },
    },
    thresholds: { cpu_pct: 100, mem_bytes: 2 ** 31, after_s: 60, interval_s: 5 },
  }
}

describe('the resource history', () => {
  it('sums Caprock as the daemon does: daemon, holders, app and its web view', () => {
    expect(caprockTotal(report(1, []))).toEqual({ cpu: 3.75, mem: 430 * MB })
  })

  it('appends live reports after the daemon\'s samples, lining sessions up and leaving gaps null', () => {
    let h = merge(emptyHistory(), fromReport(report(5_000, [sess('a', 10, MB, false)])))
    h = merge(h, fromReport(report(10_000, [sess('a', 20, 2 * MB), sess('b', 50, 3 * MB)])))
    expect(h.at).toEqual([5_000, 10_000])
    expect(h.sessions.a).toEqual({ cpu: [null, 20], mem: [MB, 2 * MB] })
    expect(h.sessions.b).toEqual({ cpu: [null, 50], mem: [null, 3 * MB] })
    expect(h.all.cpu).toEqual([0, 70])
    // A sample not newer than the newest kept is dropped, so a frame and
    // the daemon's answer carrying the same sample count it once.
    expect(merge(h, fromReport(report(10_000, [])))).toBe(h)
  })

  it('keeps no more than its capacity, nor anything older than an hour before the newest', () => {
    let h: ResourceHistory = { ...emptyHistory(), capacity: 4 }
    for (let i = 1; i <= 10; i++) h = merge(h, { ...fromReport(report(i * 5_000, [sess(`s${i}`, i, MB)])), capacity: 4 })
    expect(h.at).toEqual([35_000, 40_000, 45_000, 50_000])
    // Sessions that left the window are let go.
    expect(Object.keys(h.sessions).sort()).toEqual(['s10', 's7', 's8', 's9'])
    const later = merge(h, fromReport(report(50_000 + 61 * 60_000, [])))
    expect(later.at).toEqual([50_000 + 61 * 60_000])
  })

  it('reads now, peak and average over the window, skipping missing figures', () => {
    const h = merge(emptyHistory(), {
      ...emptyHistory(), at: [1_000, 2_000, 3_000, 4_000],
      caprock: { cpu: [9, 1, null, 3], mem: [1, 1, 1, 1] }, all: { cpu: [], mem: [] }, sessions: {},
    })
    const pts = pointsOf(h, h.caprock, 'cpu', 2_500, 4_000)
    expect(pts.map((p) => p.at)).toEqual([2_000, 3_000, 4_000])
    expect(stats(pts)).toEqual({ now: 3, peak: 3, avg: 2 })
    expect(stats([])).toEqual({ now: null, peak: null, avg: null })
  })

  it('orders the consumers by CPU, then memory, a cold CPU counting as none', () => {
    const got = topConsumers([sess('low', 2, 900 * MB), sess('cold', 500, MB, false), sess('busy', 180, MB), sess('fat', 2, 2000 * MB)], 3)
    expect(got.map((s) => s.session_id)).toEqual(['busy', 'fat', 'low'])
  })
})
